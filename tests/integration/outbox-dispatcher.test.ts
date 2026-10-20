import { randomUUID } from 'node:crypto'
import supertest from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import prisma from '../../src/db.js'
import {
  deliveryJobId,
  type DeliveryQueue,
} from '../../src/lib/delivery-queue.js'
import { reconcileScheduling } from '../../src/services/reconciliation.service.js'
import {
  dispatchOutboxBatch,
  dispatchPendingOutbox,
} from '../../src/services/outbox.service.js'
import { createTestApp } from '../helpers/test-app.js'
import { registerUser, uniqueUsername, type TestUser } from '../helpers/users.js'

const app = createTestApp()
const publicHost = 'https://93.184.216.34'

class FakeDeliveryQueue implements DeliveryQueue {
  readonly calls: Array<{ deliveryId: string; jobId: string }> = []
  readonly jobs = new Map<string, string>()
  failNext = false
  gate: Promise<void> | null = null
  onEnqueue: (() => void) | undefined

  async enqueue(deliveryId: string, jobId: string): Promise<void> {
    this.calls.push({ deliveryId, jobId })
    this.onEnqueue?.()

    if (this.gate) {
      await this.gate
    }

    if (this.failNext) {
      this.failNext = false
      throw new Error('Redis unavailable')
    }

    if (!this.jobs.has(jobId)) {
      this.jobs.set(jobId, deliveryId)
    }
  }

  async hasJob(jobId: string): Promise<boolean> {
    return this.jobs.has(jobId)
  }

  async close(): Promise<void> {}
}

interface CreatedDelivery {
  endpointId: string
  eventId: string
  deliveryId: string
  outboxId: string
  generation: number
}

describe('transactional outbox dispatcher', () => {
  let user: TestUser | undefined

  beforeEach(async () => {
    user = await registerUser(app, uniqueUsername('outbox-owner'))
  })

  afterEach(async () => {
    if (user) {
      await prisma.user.delete({ where: { id: user.id } })
      user = undefined
    }
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function createDelivery(eventType = 'payment.created'): Promise<CreatedDelivery> {
    const owner = user
    if (!owner) {
      throw new Error('Test user has not been created')
    }

    const suffix = randomUUID()
    await supertest(app)
      .post('/v1/endpoints')
      .set('X-API-Key', owner.apiKey)
      .send({ url: `${publicHost}/outbox-${suffix}`, events: [eventType] })
      .expect(201)

    const eventResponse = await supertest(app)
      .post('/v1/events')
      .set('X-API-Key', owner.apiKey)
      .send({
        idempotencyKey: `outbox-${suffix}`,
        eventType,
        payload: { reference: suffix },
      })
      .expect(202)

    const delivery = await prisma.delivery.findFirstOrThrow({
      where: { eventId: eventResponse.body.id },
      include: { outboxRecords: true },
    })

    const outbox = delivery.outboxRecords[0]
    if (!outbox) {
      throw new Error('Delivery was created without an outbox record')
    }

    return {
      endpointId: delivery.endpointId,
      eventId: delivery.eventId,
      deliveryId: delivery.id,
      outboxId: outbox.id,
      generation: outbox.generation,
    }
  }

  function jobIdFor(delivery: CreatedDelivery): string {
    return deliveryJobId(delivery.outboxId, delivery.generation)
  }

  it('publishes pending outbox records and marks them published', async () => {
    const created = await createDelivery()
    const queue = new FakeDeliveryQueue()

    const summary = await dispatchPendingOutbox({
      queue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })

    expect(summary).toEqual({ claimed: 1, published: 1, failed: 0 })
    expect(queue.calls).toEqual([
      { deliveryId: created.deliveryId, jobId: jobIdFor(created) },
    ])

    const stored = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: created.outboxId },
    })
    expect(stored.published).toBe(true)
    expect(stored.publishedAt).not.toBeNull()
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()
  })

  it('leaves records unpublished and retryable while Redis is unavailable', async () => {
    const created = await createDelivery()
    const queue = new FakeDeliveryQueue()
    queue.failNext = true
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const failedRun = await dispatchOutboxBatch({
      queue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })

    expect(failedRun).toEqual({ claimed: 1, published: 0, failed: 1 })

    let stored = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: created.outboxId },
    })
    expect(stored.published).toBe(false)
    expect(stored.publishedAt).toBeNull()
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()

    const retryRun = await dispatchPendingOutbox({
      queue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })

    expect(retryRun).toEqual({ claimed: 1, published: 1, failed: 0 })
    stored = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: created.outboxId },
    })
    expect(stored.published).toBe(true)
  })

  it('reuses the same job ID after a crash between publish and state update', async () => {
    const created = await createDelivery()
    const queue = new FakeDeliveryQueue()
    const jobId = jobIdFor(created)

    // The first dispatcher published the job and then died before updating the
    // outbox row. Leave the row unpublished with an expired claim behind.
    await queue.enqueue(created.deliveryId, jobId)
    await prisma.outboxRecord.update({
      where: { id: created.outboxId },
      data: {
        lockedBy: 'crashed-dispatcher',
        lockedUntil: new Date(Date.now() - 1_000),
      },
    })

    const summary = await dispatchPendingOutbox({
      queue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })

    expect(summary.published).toBe(1)
    expect(queue.calls).toHaveLength(2)
    expect(queue.calls.every((call) => call.jobId === jobId)).toBe(true)
    expect(queue.jobs.size).toBe(1)

    const stored = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: created.outboxId },
    })
    expect(stored.published).toBe(true)
  })

  it('skips actively leased records and reclaims them after the lease expires', async () => {
    const created = await createDelivery()
    const queue = new FakeDeliveryQueue()

    await prisma.outboxRecord.update({
      where: { id: created.outboxId },
      data: {
        lockedBy: 'other-dispatcher',
        lockedUntil: new Date(Date.now() + 60_000),
      },
    })

    const skipped = await dispatchOutboxBatch({
      queue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })
    expect(skipped.claimed).toBe(0)
    expect(queue.calls).toHaveLength(0)

    await prisma.outboxRecord.update({
      where: { id: created.outboxId },
      data: { lockedUntil: new Date(Date.now() - 1_000) },
    })

    const reclaimed = await dispatchOutboxBatch({
      queue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })
    expect(reclaimed.published).toBe(1)
    expect(queue.calls).toHaveLength(1)
  })

  it('prevents concurrent dispatchers from publishing the same record twice', async () => {
    const created = await createDelivery()
    const queue = new FakeDeliveryQueue()

    let releasePublish: () => void = () => {}
    queue.gate = new Promise<void>((resolve) => {
      releasePublish = resolve
    })

    let signalEnqueued: () => void = () => {}
    const enqueued = new Promise<void>((resolve) => {
      signalEnqueued = resolve
    })
    queue.onEnqueue = signalEnqueued

    const firstRun = dispatchPendingOutbox({
      queue,
      batchSize: 10,
      leaseDurationMs: 30_000,
    })

    await enqueued

    const secondRun = await dispatchPendingOutbox({
      queue,
      batchSize: 10,
      leaseDurationMs: 30_000,
    })
    expect(secondRun.claimed).toBe(0)

    releasePublish()
    const firstSummary = await firstRun

    expect(firstSummary.published).toBe(1)
    expect(queue.calls).toHaveLength(1)
    expect(queue.jobs.size).toBe(1)

    const stored = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: created.outboxId },
    })
    expect(stored.published).toBe(true)
  })

  it('reconciliation creates an outbox record for an eligible delivery without one', async () => {
    const created = await createDelivery()
    await prisma.outboxRecord.delete({ where: { id: created.outboxId } })

    const queue = new FakeDeliveryQueue()
    const summary = await reconcileScheduling({ queue, batchSize: 10 })

    expect(summary.created).toBe(1)

    const outbox = await prisma.outboxRecord.findUniqueOrThrow({
      where: { deliveryId: created.deliveryId },
    })
    expect(outbox.published).toBe(false)
    expect(outbox.generation).toBe(0)

    const dispatch = await dispatchPendingOutbox({ queue, batchSize: 10 })
    expect(dispatch.published).toBe(1)
    expect(queue.calls).toEqual([
      {
        deliveryId: created.deliveryId,
        jobId: deliveryJobId(outbox.id, outbox.generation),
      },
    ])
  })

  it('reconciliation reschedules when a published queue job has disappeared', async () => {
    const created = await createDelivery()
    const queue = new FakeDeliveryQueue()

    await dispatchPendingOutbox({ queue, batchSize: 10 })
    queue.jobs.clear()

    const summary = await reconcileScheduling({ queue, batchSize: 10 })
    expect(summary.rescheduled).toBe(1)

    let outbox = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: created.outboxId },
    })
    expect(outbox.published).toBe(false)
    expect(outbox.publishedAt).toBeNull()
    expect(outbox.generation).toBe(1)

    const dispatch = await dispatchPendingOutbox({ queue, batchSize: 10 })
    expect(dispatch.published).toBe(1)
    expect(queue.calls.at(-1)).toEqual({
      deliveryId: created.deliveryId,
      jobId: deliveryJobId(outbox.id, 1),
    })

    outbox = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: created.outboxId },
    })
    expect(outbox.published).toBe(true)
  })

  it('reconciliation leaves active jobs and terminal deliveries alone', async () => {
    const active = await createDelivery()
    const terminal = await createDelivery()
    const queue = new FakeDeliveryQueue()

    await dispatchPendingOutbox({ queue, batchSize: 10 })

    await prisma.delivery.update({
      where: { id: terminal.deliveryId },
      data: { status: 'SUCCEEDED' },
    })
    queue.jobs.delete(jobIdFor(terminal))

    const summary = await reconcileScheduling({ queue, batchSize: 10 })

    expect(summary.created).toBe(0)
    expect(summary.rescheduled).toBe(0)

    const activeOutbox = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: active.outboxId },
    })
    expect(activeOutbox.published).toBe(true)
    expect(activeOutbox.generation).toBe(0)

    const terminalOutbox = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: terminal.outboxId },
    })
    expect(terminalOutbox.published).toBe(true)
    expect(terminalOutbox.generation).toBe(0)
  })
})
