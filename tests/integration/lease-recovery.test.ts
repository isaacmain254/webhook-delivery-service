import { randomUUID } from 'node:crypto'
import supertest from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import prisma from '../../src/db.js'
import {
  deliveryJobId,
  type DeliveryQueue,
} from '../../src/lib/delivery-queue.js'
import {
  dispatchOutboxBatch,
} from '../../src/services/outbox.service.js'
import { reconcileScheduling } from '../../src/services/reconciliation.service.js'
import { createTestApp } from '../helpers/test-app.js'
import { registerUser, uniqueUsername, type TestUser } from '../helpers/users.js'

const app = createTestApp()
const publicHost = 'https://93.184.216.34'

class FakeDeliveryQueue implements DeliveryQueue {
  readonly calls: Array<{ deliveryId: string; jobId: string; delayMs?: number }> = []
  readonly jobs = new Map<string, string>()

  async enqueue(
    deliveryId: string,
    jobId: string,
    options?: { delayMs?: number },
  ): Promise<void> {
    this.calls.push({
      deliveryId,
      jobId,
      ...(options?.delayMs ? { delayMs: options.delayMs } : {}),
    })
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

describe('delivery lease recovery', () => {
  let user: TestUser | undefined

  beforeEach(async () => {
    user = await registerUser(app, uniqueUsername('lease-owner'))
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

  async function createDelivery(): Promise<CreatedDelivery> {
    const owner = user
    if (!owner) {
      throw new Error('Test user has not been created')
    }

    const suffix = randomUUID()
    const eventType = 'payment.succeeded'
    await supertest(app)
      .post('/v1/endpoints')
      .set('X-API-Key', owner.apiKey)
      .send({ url: `${publicHost}/lease-${suffix}`, events: [eventType] })
      .expect(201)

    const eventResponse = await supertest(app)
      .post('/v1/events')
      .set('X-API-Key', owner.apiKey)
      .send({
        idempotencyKey: `lease-${suffix}`,
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

  async function publish(delivery: CreatedDelivery): Promise<void> {
    const summary = await dispatchOutboxBatch({
      queue: new FakeDeliveryQueue(),
      batchSize: 10,
      leaseDurationMs: 5_000,
    })
    expect(summary.published).toBe(1)
  }

  async function markProcessing(
    delivery: CreatedDelivery,
    options: {
      retryCount?: number
      lockedUntil?: Date | null
      lockedBy?: string | null
    } = {},
  ): Promise<void> {
    await prisma.delivery.update({
      where: { id: delivery.deliveryId },
      data: {
        status: 'PROCESSING',
        retryCount: options.retryCount ?? 0,
        lockedBy: options.lockedBy ?? 'dead-worker',
        lockedUntil:
          options.lockedUntil === undefined
            ? new Date(Date.now() + 60_000)
            : options.lockedUntil,
      },
    })

    await prisma.deliveryAttempts.create({
      data: {
        deliveryId: delivery.deliveryId,
        attemptCount: (options.retryCount ?? 0) + 1,
        startedAt: new Date(Date.now() - 10_000),
        duration: '0',
      },
    })
  }

  it('recovers an expired lease, closes the attempt, and reschedules work', async () => {
    const created = await createDelivery()
    await publish(created)
    await markProcessing(created, {
      lockedUntil: new Date(Date.now() - 1_000),
    })

    const queue = new FakeDeliveryQueue()
    const summary = await reconcileScheduling({ queue, batchSize: 10 })

    expect(summary.recoveredLeases).toBe(1)
    expect(summary.failedLeases).toBe(0)

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })

    expect(stored.status).toBe('RETRYING')
    expect(stored.retryCount).toBe(1)
    expect(stored.nextAttempt).toBeInstanceOf(Date)
    expect(stored.nextAttempt?.getTime()).toBeLessThanOrEqual(Date.now())
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()

    expect(stored.outboxRecords[0]?.published).toBe(false)
    expect(stored.outboxRecords[0]?.generation).toBe(1)

    expect(stored.attempts).toHaveLength(1)
    const abandoned = stored.attempts[0]
    expect(abandoned?.completedAt).toBeInstanceOf(Date)
    expect(abandoned?.statusCode).toBeNull()
    expect(JSON.parse(abandoned?.response ?? '')).toEqual({
      error: 'LEASE_EXPIRED',
    })
    expect(abandoned?.duration).toMatch(/^\d+$/)
    expect(Number(abandoned?.duration)).toBeGreaterThanOrEqual(9_000)

    const retryQueue = new FakeDeliveryQueue()
    const dispatch = await dispatchOutboxBatch({
      queue: retryQueue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })

    expect(dispatch.published).toBe(1)
    expect(retryQueue.calls).toEqual([
      {
        deliveryId: created.deliveryId,
        jobId: deliveryJobId(created.outboxId, 1),
      },
    ])
  })

  it('does not recover a lease that is still active', async () => {
    const created = await createDelivery()
    await publish(created)
    await markProcessing(created)

    const queue = new FakeDeliveryQueue()
    const summary = await reconcileScheduling({ queue, batchSize: 10 })

    expect(summary.recoveredLeases).toBe(0)
    expect(summary.failedLeases).toBe(0)

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })
    expect(stored.status).toBe('PROCESSING')
    expect(stored.lockedBy).toBe('dead-worker')
    expect(stored.attempts[0]?.completedAt).toBeNull()
    expect(stored.outboxRecords[0]?.published).toBe(true)
    expect(stored.outboxRecords[0]?.generation).toBe(0)
  })

  it('treats a PROCESSING delivery with no lease as abandoned', async () => {
    const created = await createDelivery()
    await publish(created)
    await markProcessing(created, { lockedUntil: null })

    const summary = await reconcileScheduling({
      queue: new FakeDeliveryQueue(),
      batchSize: 10,
    })

    expect(summary.recoveredLeases).toBe(1)

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
    })
    expect(stored.status).toBe('RETRYING')
    expect(stored.retryCount).toBe(1)
  })

  it('fails a delivery when the final attempt lease expires', async () => {
    const created = await createDelivery()
    await publish(created)
    await markProcessing(created, {
      retryCount: 4,
      lockedUntil: new Date(Date.now() - 1_000),
    })

    const summary = await reconcileScheduling({
      queue: new FakeDeliveryQueue(),
      batchSize: 10,
    })

    expect(summary.recoveredLeases).toBe(0)
    expect(summary.failedLeases).toBe(1)

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })
    expect(stored.status).toBe('FAILED')
    expect(stored.retryCount).toBe(4)
    expect(stored.nextAttempt).toBeNull()
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()
    expect(stored.outboxRecords[0]?.published).toBe(true)
    expect(stored.outboxRecords[0]?.generation).toBe(0)
    expect(stored.attempts).toHaveLength(1)
    expect(JSON.parse(stored.attempts[0]?.response ?? '')).toEqual({
      error: 'LEASE_EXPIRED',
    })
  })

  it('does not let concurrent reconcilers recover the same lease twice', async () => {
    const created = await createDelivery()
    await publish(created)
    await markProcessing(created, {
      lockedUntil: new Date(Date.now() - 1_000),
    })

    const [first, second] = await Promise.all([
      reconcileScheduling({ queue: new FakeDeliveryQueue(), batchSize: 10 }),
      reconcileScheduling({ queue: new FakeDeliveryQueue(), batchSize: 10 }),
    ])

    expect(first.recoveredLeases + second.recoveredLeases).toBe(1)

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { outboxRecords: true },
    })
    expect(stored.status).toBe('RETRYING')
    expect(stored.retryCount).toBe(1)
    expect(stored.outboxRecords[0]?.generation).toBe(1)
  })
})
