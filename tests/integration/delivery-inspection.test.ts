import { randomUUID } from 'node:crypto'
import supertest from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import prisma from '../../src/db.js'
import {
  deliveryJobId,
  type DeliveryQueue,
} from '../../src/lib/delivery-queue.js'
import type { DeliveryTransport } from '../../src/lib/delivery-http.js'
import type { DeliveryStatus } from '../../src/generated/prisma/enums.js'
import { processDeliveryJob } from '../../src/services/delivery.service.js'
import { dispatchOutboxBatch } from '../../src/services/outbox.service.js'
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

function successfulTransport(): DeliveryTransport {
  return {
    async send() {
      return { statusCode: 200, body: 'received', truncated: false }
    },
  }
}

interface CreatedDelivery {
  endpointId: string
  endpointUrl: string
  eventId: string
  eventType: string
  payload: Record<string, unknown>
  deliveryId: string
  outboxId: string
  outboxGeneration: number
}

async function addAttempt(
  deliveryId: string,
  options: {
    replayCount?: number
    attemptCount: number
    statusCode?: string | null
    response?: string | null
    duration?: string
  },
): Promise<void> {
  await prisma.deliveryAttempts.create({
    data: {
      deliveryId,
      replayCount: options.replayCount ?? 0,
      attemptCount: options.attemptCount,
      startedAt: new Date(Date.now() - 1_000),
      completedAt: new Date(),
      statusCode: options.statusCode ?? null,
      response: options.response ?? null,
      duration: options.duration ?? '10',
    },
  })
}

async function setDeliveryState(
  deliveryId: string,
  data: {
    status: DeliveryStatus
    retryCount?: number
    replayCount?: number
    statusCode?: string | null
    response?: string | null
    duration?: string | null
    lockedBy?: string | null
    lockedUntil?: Date | null
  },
): Promise<void> {
  await prisma.delivery.update({
    where: { id: deliveryId },
    data: {
      status: data.status,
      ...(data.retryCount === undefined ? {} : { retryCount: data.retryCount }),
      ...(data.replayCount === undefined ? {} : { replayCount: data.replayCount }),
      ...(data.statusCode === undefined ? {} : { statusCode: data.statusCode }),
      ...(data.response === undefined ? {} : { response: data.response }),
      ...(data.duration === undefined ? {} : { duration: data.duration }),
      ...(data.lockedBy === undefined ? {} : { lockedBy: data.lockedBy }),
      ...(data.lockedUntil === undefined ? {} : { lockedUntil: data.lockedUntil }),
    },
  })
}

describe('delivery inspection and replay API', () => {
  let owner: TestUser
  let other: TestUser

  beforeEach(async () => {
    owner = await registerUser(app, uniqueUsername('inspection-owner'))
    other = await registerUser(app, uniqueUsername('inspection-other'))
  })

  afterEach(async () => {
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, other.id] } } })
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  async function createDelivery(
    eventType = 'payment.succeeded',
  ): Promise<CreatedDelivery> {
    const suffix = randomUUID()
    const endpointUrl = `${publicHost}/inspection-${suffix}`
    const payload = { reference: suffix, amount: 1_000, currency: 'usd' }

    const endpointResponse = await supertest(app)
      .post('/v1/endpoints')
      .set('X-API-Key', owner.apiKey)
      .send({ url: endpointUrl, events: [eventType] })
      .expect(201)

    const eventResponse = await supertest(app)
      .post('/v1/events')
      .set('X-API-Key', owner.apiKey)
      .send({
        idempotencyKey: `inspection-${suffix}`,
        eventType,
        payload,
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
      endpointId: endpointResponse.body.id as string,
      endpointUrl,
      eventId: eventResponse.body.id as string,
      eventType,
      payload,
      deliveryId: delivery.id,
      outboxId: outbox.id,
      outboxGeneration: outbox.generation,
    }
  }

  it('returns event details with payload, delivery summaries, and attempt counts', async () => {
    const created = await createDelivery()
    await setDeliveryState(created.deliveryId, {
      status: 'FAILED',
      retryCount: 4,
      statusCode: '500',
      response: JSON.stringify({ body: 'unavailable', truncated: false }),
      duration: '123',
    })

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await addAttempt(created.deliveryId, {
        attemptCount: attempt,
        statusCode: '500',
        response: JSON.stringify({ body: `attempt-${attempt}`, truncated: false }),
        duration: '123',
      })
    }

    const response = await supertest(app)
      .get(`/v1/events/${created.eventId}`)
      .set('X-API-Key', owner.apiKey)
      .expect(200)

    expect(response.body).toMatchObject({
      id: created.eventId,
      eventType: created.eventType,
      payload: created.payload,
      createdOn: expect.any(String),
      deliveries: [
        {
          id: created.deliveryId,
          eventId: created.eventId,
          endpointId: created.endpointId,
          status: 'FAILED',
          retryCount: 4,
          replayCount: 0,
          statusCode: 500,
          response: { body: 'unavailable', truncated: false },
          durationMs: 123,
          attemptCount: 5,
        },
      ],
    })
    expect(response.body.idempotencyKey).toBe(`inspection-${created.payload.reference}`)
    expect(response.body.deliveries[0]).not.toHaveProperty('signingSecret')
    expect(response.body.deliveries[0]).not.toHaveProperty('lockedBy')
    expect(response.body.deliveries[0]).not.toHaveProperty('lockedUntil')
  })

  it('lists deliveries for owned events and returns 404 for foreign or unknown events', async () => {
    const created = await createDelivery()

    const listed = await supertest(app)
      .get(`/v1/events/${created.eventId}/deliveries`)
      .set('X-API-Key', owner.apiKey)
      .expect(200)

    expect(listed.body).toHaveLength(1)
    expect(listed.body[0]).toMatchObject({
      id: created.deliveryId,
      eventId: created.eventId,
      endpointId: created.endpointId,
      status: 'PENDING',
      retryCount: 0,
      replayCount: 0,
      attemptCount: 0,
    })

    const emptyEvent = await supertest(app)
      .post('/v1/events')
      .set('X-API-Key', owner.apiKey)
      .send({
        idempotencyKey: `empty-${randomUUID()}`,
        eventType: 'payment.refunded',
        payload: { reference: randomUUID() },
      })
      .expect(202)

    const emptyEventResponse = await supertest(app)
      .get(`/v1/events/${emptyEvent.body.id}`)
      .set('X-API-Key', owner.apiKey)
      .expect(200)
    expect(emptyEventResponse.body.deliveries).toEqual([])

    const emptyDeliveries = await supertest(app)
      .get(`/v1/events/${emptyEvent.body.id}/deliveries`)
      .set('X-API-Key', owner.apiKey)
      .expect(200)
    expect(emptyDeliveries.body).toEqual([])

    await supertest(app)
      .get(`/v1/events/${created.eventId}`)
      .set('X-API-Key', other.apiKey)
      .expect(404)
    await supertest(app)
      .get(`/v1/events/${created.eventId}/deliveries`)
      .set('X-API-Key', other.apiKey)
      .expect(404)
    await supertest(app)
      .get('/v1/events/00000000-0000-4000-8000-000000000000')
      .set('X-API-Key', owner.apiKey)
      .expect(404)
    await supertest(app)
      .get('/v1/events/not-a-uuid')
      .set('X-API-Key', owner.apiKey)
      .expect(422)
    await supertest(app).get(`/v1/events/${created.eventId}`).expect(401)
  })

  it('returns delivery details and complete, ordered attempt history', async () => {
    const created = await createDelivery()
    await setDeliveryState(created.deliveryId, {
      status: 'FAILED',
      retryCount: 4,
      replayCount: 1,
      statusCode: '500',
      response: JSON.stringify({ body: 'last failure', truncated: false }),
      duration: '250',
      lockedBy: null,
      lockedUntil: null,
    })

    await addAttempt(created.deliveryId, {
      replayCount: 0,
      attemptCount: 1,
      statusCode: '503',
      response: JSON.stringify({ body: 'original failure', truncated: false }),
      duration: '100',
    })
    await addAttempt(created.deliveryId, {
      replayCount: 1,
      attemptCount: 1,
      statusCode: '500',
      response: JSON.stringify({ body: 'replay failure', truncated: false }),
      duration: '200',
    })

    const detail = await supertest(app)
      .get(`/v1/deliveries/${created.deliveryId}`)
      .set('X-API-Key', owner.apiKey)
      .expect(200)

    expect(detail.body).toMatchObject({
      id: created.deliveryId,
      eventId: created.eventId,
      endpointId: created.endpointId,
      status: 'FAILED',
      retryCount: 4,
      replayCount: 1,
      statusCode: 500,
      response: { body: 'last failure', truncated: false },
      durationMs: 250,
      attemptCount: 2,
      event: {
        id: created.eventId,
        eventType: created.eventType,
        createdOn: expect.any(String),
      },
      endpoint: {
        id: created.endpointId,
        url: created.endpointUrl,
        status: 'ACTIVE',
      },
    })
    expect(detail.body).not.toHaveProperty('signingSecret')
    expect(detail.body).not.toHaveProperty('lockedBy')
    expect(detail.body).not.toHaveProperty('lockedUntil')
    expect(detail.body).not.toHaveProperty('userId')

    const attempts = await supertest(app)
      .get(`/v1/deliveries/${created.deliveryId}/attempts`)
      .set('X-API-Key', owner.apiKey)
      .expect(200)

    expect(attempts.body).toHaveLength(2)
    expect(attempts.body[0]).toMatchObject({
      replayCount: 0,
      attemptCount: 1,
      statusCode: 503,
      response: { body: 'original failure', truncated: false },
      durationMs: 100,
      startedAt: expect.any(String),
      completedAt: expect.any(String),
    })
    expect(attempts.body[1]).toMatchObject({
      replayCount: 1,
      attemptCount: 1,
      statusCode: 500,
      response: { body: 'replay failure', truncated: false },
      durationMs: 200,
    })

    await supertest(app)
      .get(`/v1/deliveries/${created.deliveryId}`)
      .set('X-API-Key', other.apiKey)
      .expect(404)
    await supertest(app)
      .get(`/v1/deliveries/${created.deliveryId}/attempts`)
      .set('X-API-Key', other.apiKey)
      .expect(404)
    await supertest(app)
      .get('/v1/deliveries/00000000-0000-4000-8000-000000000000')
      .set('X-API-Key', owner.apiKey)
      .expect(404)
    await supertest(app)
      .get('/v1/deliveries/not-a-uuid/attempts')
      .set('X-API-Key', owner.apiKey)
      .expect(422)
  })

  it('replays FAILED and SUCCEEDED deliveries while preserving attempt history', async () => {
    const failed = await createDelivery()
    const succeeded = await createDelivery('invoice.paid')

    await setDeliveryState(failed.deliveryId, {
      status: 'FAILED',
      retryCount: 4,
      statusCode: '500',
      response: JSON.stringify({ body: 'failed', truncated: false }),
      duration: '50',
    })
    await addAttempt(failed.deliveryId, {
      attemptCount: 5,
      statusCode: '500',
      response: JSON.stringify({ body: 'failed', truncated: false }),
      duration: '50',
    })

    await setDeliveryState(succeeded.deliveryId, {
      status: 'SUCCEEDED',
      retryCount: 0,
      statusCode: '200',
      response: JSON.stringify({ body: 'ok', truncated: false }),
      duration: '10',
    })

    const failedReplay = await supertest(app)
      .post(`/v1/deliveries/${failed.deliveryId}/replay`)
      .set('X-API-Key', owner.apiKey)
      .expect(202)
    const succeededReplay = await supertest(app)
      .post(`/v1/deliveries/${succeeded.deliveryId}/replay`)
      .set('X-API-Key', owner.apiKey)
      .expect(202)

    for (const response of [failedReplay, succeededReplay]) {
      expect(response.body).toMatchObject({
        status: 'PENDING',
        retryCount: 0,
        replayCount: 1,
        statusCode: null,
        response: null,
        durationMs: null,
      })
      expect(response.body.nextAttempt).toEqual(expect.any(String))
    }

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: failed.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })
    expect(stored.status).toBe('PENDING')
    expect(stored.retryCount).toBe(0)
    expect(stored.replayCount).toBe(1)
    expect(stored.statusCode).toBeNull()
    expect(stored.response).toBeNull()
    expect(stored.duration).toBeNull()
    expect(stored.nextAttempt).toBeInstanceOf(Date)
    expect(stored.attempts).toHaveLength(1)
    expect(stored.attempts[0]).toMatchObject({
      replayCount: 0,
      attemptCount: 5,
      statusCode: '500',
    })
    expect(stored.outboxRecords[0]?.generation).toBe(failed.outboxGeneration + 1)
    expect(stored.outboxRecords[0]?.published).toBe(false)

    const succeededStored = await prisma.delivery.findUniqueOrThrow({
      where: { id: succeeded.deliveryId },
      include: { outboxRecords: true },
    })
    expect(succeededStored.replayCount).toBe(1)
    expect(succeededStored.outboxRecords[0]?.generation).toBe(
      succeeded.outboxGeneration + 1,
    )
  })

  it('rejects replay for active deliveries, foreign owners, and malformed ids', async () => {
    const created = await createDelivery()
    await setDeliveryState(created.deliveryId, { status: 'FAILED' })
    await addAttempt(created.deliveryId, { attemptCount: 1 })

    await supertest(app)
      .post(`/v1/deliveries/${created.deliveryId}/replay`)
      .set('X-API-Key', other.apiKey)
      .expect(404)

    const unchanged = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
    })
    expect(unchanged.status).toBe('FAILED')
    expect(unchanged.replayCount).toBe(0)

    for (const status of ['PENDING', 'PROCESSING', 'RETRYING'] as const) {
      await setDeliveryState(created.deliveryId, {
        status,
        ...(status === 'PROCESSING'
          ? { lockedBy: 'active-worker', lockedUntil: new Date(Date.now() + 60_000) }
          : {}),
      })

      const response = await supertest(app)
        .post(`/v1/deliveries/${created.deliveryId}/replay`)
        .set('X-API-Key', owner.apiKey)
        .expect(409)

      expect(response.body.error).toMatchObject({
        code: 'DELIVERY_NOT_REPLAYABLE',
        details: [{ path: 'status', message: `Delivery status is ${status}` }],
      })
    }

    await supertest(app)
      .post('/v1/deliveries/00000000-0000-4000-8000-000000000000/replay')
      .set('X-API-Key', owner.apiKey)
      .expect(404)
    await supertest(app)
      .post('/v1/deliveries/not-a-uuid/replay')
      .set('X-API-Key', owner.apiKey)
      .expect(422)
  })

  it('accepts only one of two concurrent replay requests', async () => {
    const created = await createDelivery()
    await setDeliveryState(created.deliveryId, { status: 'FAILED', retryCount: 3 })
    await addAttempt(created.deliveryId, { attemptCount: 4, statusCode: '500' })

    const responses = await Promise.all([
      supertest(app)
        .post(`/v1/deliveries/${created.deliveryId}/replay`)
        .set('X-API-Key', owner.apiKey),
      supertest(app)
        .post(`/v1/deliveries/${created.deliveryId}/replay`)
        .set('X-API-Key', owner.apiKey),
    ])

    expect(responses.map((response) => response.status).sort()).toEqual([202, 409])

    const accepted = responses.find((response) => response.status === 202)
    const rejected = responses.find((response) => response.status === 409)
    expect(accepted?.body).toMatchObject({
      status: 'PENDING',
      replayCount: 1,
      retryCount: 0,
    })
    expect(rejected?.body.error.code).toBe('DELIVERY_NOT_REPLAYABLE')

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })
    expect(stored.status).toBe('PENDING')
    expect(stored.replayCount).toBe(1)
    expect(stored.attempts).toHaveLength(1)
    expect(stored.attempts[0]?.replayCount).toBe(0)
    expect(stored.outboxRecords[0]?.generation).toBe(created.outboxGeneration + 1)
    expect(stored.outboxRecords[0]?.published).toBe(false)
  })

  it('creates a new durable outbox generation and dispatches a replay job', async () => {
    const created = await createDelivery()
    await setDeliveryState(created.deliveryId, { status: 'FAILED' })

    await supertest(app)
      .post(`/v1/deliveries/${created.deliveryId}/replay`)
      .set('X-API-Key', owner.apiKey)
      .expect(202)

    const storedOutbox = await prisma.outboxRecord.findUniqueOrThrow({
      where: { deliveryId: created.deliveryId },
    })
    expect(storedOutbox.generation).toBe(created.outboxGeneration + 1)
    expect(storedOutbox.published).toBe(false)

    const queue = new FakeDeliveryQueue()
    const summary = await dispatchOutboxBatch({
      queue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })

    expect(summary).toEqual({ claimed: 1, published: 1, failed: 0 })
    expect(queue.calls).toEqual([
      {
        deliveryId: created.deliveryId,
        jobId: deliveryJobId(created.outboxId, created.outboxGeneration + 1),
      },
    ])
  })

  it('records a worker attempt under the new replay cycle', async () => {
    const created = await createDelivery()
    await setDeliveryState(created.deliveryId, {
      status: 'FAILED',
      retryCount: 4,
      statusCode: '500',
    })
    await addAttempt(created.deliveryId, {
      replayCount: 0,
      attemptCount: 5,
      statusCode: '500',
    })

    await supertest(app)
      .post(`/v1/deliveries/${created.deliveryId}/replay`)
      .set('X-API-Key', owner.apiKey)
      .expect(202)

    const result = await processDeliveryJob(created.deliveryId, {
      workerId: 'replay-worker',
      transport: successfulTransport(),
    })

    expect(result).toEqual({
      deliveryId: created.deliveryId,
      outcome: 'succeeded',
      attemptCount: 1,
    })

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: {
        attempts: {
          orderBy: [{ replayCount: 'asc' }, { attemptCount: 'asc' }],
        },
      },
    })

    expect(stored.status).toBe('SUCCEEDED')
    expect(stored.replayCount).toBe(1)
    expect(stored.retryCount).toBe(0)
    expect(stored.attempts).toHaveLength(2)
    expect(stored.attempts[0]).toMatchObject({
      replayCount: 0,
      attemptCount: 5,
      statusCode: '500',
    })
    expect(stored.attempts[1]).toMatchObject({
      replayCount: 1,
      attemptCount: 1,
      statusCode: '200',
      duration: expect.stringMatching(/^\d+$/),
    })
    expect(stored.attempts[1]?.completedAt).toBeInstanceOf(Date)
  })
})
