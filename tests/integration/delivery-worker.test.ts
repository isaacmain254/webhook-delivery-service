import { randomUUID } from 'node:crypto'
import supertest from 'supertest'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import prisma from '../../src/db.js'
import {
  DeliveryTransportError,
  type DeliveryTransport,
  type WebhookHttpRequest,
  type WebhookHttpResponse,
} from '../../src/lib/delivery-http.js'
import {
  deliveryJobId,
  type DeliveryQueue,
} from '../../src/lib/delivery-queue.js'
import { verifyWebhookSignature } from '../../src/lib/hmac.js'
import { SsrfError } from '../../src/lib/ssrf.js'
import { processDeliveryJob } from '../../src/services/delivery.service.js'
import { dispatchOutboxBatch } from '../../src/services/outbox.service.js'
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

class FakeTransport implements DeliveryTransport {
  readonly requests: WebhookHttpRequest[] = []
  response: WebhookHttpResponse | Error = {
    statusCode: 200,
    body: 'ok',
    truncated: false,
  }
  gate: Promise<void> | null = null
  onRequest: (() => void) | undefined

  async send(request: WebhookHttpRequest): Promise<WebhookHttpResponse> {
    this.requests.push(request)
    this.onRequest?.()

    if (this.gate) {
      await this.gate
    }

    if (this.response instanceof Error) {
      throw this.response
    }

    return this.response
  }
}

interface CreatedDelivery {
  endpointId: string
  endpointUrl: string
  signingSecret: string
  eventId: string
  eventType: string
  payload: Record<string, unknown>
  deliveryId: string
  outboxId: string
  generation: number
}

describe('delivery worker', () => {
  let user: TestUser | undefined

  beforeEach(async () => {
    user = await registerUser(app, uniqueUsername('delivery-owner'))
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

  async function createDelivery(
    eventType = 'payment.succeeded',
  ): Promise<CreatedDelivery> {
    const owner = user
    if (!owner) {
      throw new Error('Test user has not been created')
    }

    const suffix = randomUUID()
    const endpointUrl = `${publicHost}/worker-${suffix}`
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
        idempotencyKey: `worker-${suffix}`,
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
      signingSecret: endpointResponse.body.signingSecret as string,
      eventId: eventResponse.body.id as string,
      eventType,
      payload,
      deliveryId: delivery.id,
      outboxId: outbox.id,
      generation: outbox.generation,
    }
  }

  async function publishDelivery(delivery: CreatedDelivery): Promise<void> {
    const queue = new FakeDeliveryQueue()
    const summary = await dispatchOutboxBatch({
      queue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })

    expect(summary.published).toBe(1)
    expect(queue.calls).toEqual([
      {
        deliveryId: delivery.deliveryId,
        jobId: deliveryJobId(delivery.outboxId, delivery.generation),
      },
    ])
  }

  it('sends a signed request and records a successful delivery', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    const transport = new FakeTransport()
    transport.response = { statusCode: 200, body: 'received', truncated: false }

    const result = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-success',
      transport,
    })

    expect(result).toEqual({
      deliveryId: created.deliveryId,
      outcome: 'succeeded',
      attemptCount: 1,
    })
    expect(transport.requests).toHaveLength(1)

    const sent = transport.requests[0]
    if (!sent) {
      throw new Error('No request was sent')
    }

    expect(sent.url).toBe(created.endpointUrl)
    expect(sent.headers['x-webhook-event-id']).toBe(created.eventId)
    expect(sent.headers['x-webhook-event-type']).toBe(created.eventType)
    expect(sent.headers['x-webhook-delivery-id']).toBe(created.deliveryId)
    expect(sent.headers['content-type']).toBe('application/json')
    expect(sent.headers['content-length']).toBe(String(sent.body.byteLength))
    expect(Number(sent.headers['x-webhook-timestamp'])).toBeGreaterThan(0)
    expect(
      verifyWebhookSignature({
        secret: created.signingSecret,
        timestamp: sent.headers['x-webhook-timestamp'] ?? '',
        body: sent.body,
        signature: sent.headers['x-webhook-signature'] ?? '',
      }),
    ).toBe(true)

    expect(JSON.parse(sent.body.toString('utf8'))).toEqual({
      id: created.eventId,
      type: created.eventType,
      createdAt: expect.any(String),
      data: created.payload,
    })

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })

    expect(stored.status).toBe('SUCCEEDED')
    expect(stored.statusCode).toBe('200')
    expect(JSON.parse(stored.response ?? '')).toEqual({
      body: 'received',
      truncated: false,
    })
    expect(stored.duration).toMatch(/^\d+$/)
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()
    expect(stored.nextAttempt).toBeNull()
    expect(stored.attempts).toHaveLength(1)

    const attempt = stored.attempts[0]
    expect(attempt?.attemptCount).toBe(1)
    expect(attempt?.replayCount).toBe(0)
    expect(attempt?.startedAt).toBeInstanceOf(Date)
    expect(attempt?.completedAt).toBeInstanceOf(Date)
    expect(attempt?.statusCode).toBe('200')
    expect(attempt?.duration).toMatch(/^\d+$/)
    expect(stored.outboxRecords[0]?.published).toBe(true)
    expect(stored.outboxRecords[0]?.generation).toBe(0)
  })

  it('records retryable HTTP failures and reschedules through the outbox', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    const transport = new FakeTransport()
    transport.response = { statusCode: 503, body: 'unavailable', truncated: false }

    const result = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-retry',
      transport,
    })

    expect(result).toEqual({
      deliveryId: created.deliveryId,
      outcome: 'retrying',
      attemptCount: 1,
    })

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })

    expect(stored.status).toBe('RETRYING')
    expect(stored.retryCount).toBe(1)
    expect(stored.nextAttempt).toBeInstanceOf(Date)
    expect(stored.nextAttempt?.getTime()).toBeGreaterThan(Date.now())
    expect(stored.statusCode).toBe('503')
    expect(JSON.parse(stored.response ?? '')).toEqual({
      body: 'unavailable',
      truncated: false,
    })
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()
    expect(stored.attempts).toHaveLength(1)
    expect(stored.attempts[0]?.statusCode).toBe('503')

    const outbox = stored.outboxRecords[0]
    expect(outbox?.published).toBe(false)
    expect(outbox?.publishedAt).toBeNull()
    expect(outbox?.generation).toBe(1)
    expect(outbox?.lockedUntil).toBeNull()
    expect(outbox?.lockedBy).toBeNull()

    // A duplicate job that arrives before nextAttempt must not send again.
    const early = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-early',
      transport,
    })
    expect(early).toEqual({
      deliveryId: created.deliveryId,
      outcome: 'skipped',
    })
    expect(transport.requests).toHaveLength(1)

    const retryQueue = new FakeDeliveryQueue()
    const summary = await dispatchOutboxBatch({
      queue: retryQueue,
      batchSize: 10,
      leaseDurationMs: 5_000,
    })

    expect(summary).toEqual({ claimed: 1, published: 1, failed: 0 })
    expect(retryQueue.calls).toHaveLength(1)
    expect(retryQueue.calls[0]?.jobId).toBe(deliveryJobId(created.outboxId, 1))
    expect(retryQueue.calls[0]?.delayMs).toBeGreaterThan(0)

    const scheduled = await prisma.outboxRecord.findUniqueOrThrow({
      where: { id: created.outboxId },
    })
    expect(scheduled.published).toBe(true)
    expect(scheduled.generation).toBe(1)
  })

  it('honors a bounded Retry-After header on HTTP 429', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    const transport = new FakeTransport()
    transport.response = {
      statusCode: 429,
      body: 'rate limited',
      truncated: false,
      retryAfter: '2',
    }

    const before = Date.now()
    const result = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-retry-after',
      transport,
    })
    const after = Date.now()

    expect(result.outcome).toBe('retrying')

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { outboxRecords: true },
    })
    expect(stored.status).toBe('RETRYING')
    expect(stored.retryCount).toBe(1)
    expect(stored.nextAttempt).toBeInstanceOf(Date)

    const delayMs = (stored.nextAttempt?.getTime() ?? 0) - before
    const elapsedMs = after - before
    expect(delayMs).toBeGreaterThanOrEqual(2_000)
    expect(delayMs).toBeLessThanOrEqual(2_000 + elapsedMs + 1_000)
    expect(stored.outboxRecords[0]?.published).toBe(false)
    expect(stored.outboxRecords[0]?.generation).toBe(1)
  })

  it('records timeouts as retryable failures without a status code', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    const transport = new FakeTransport()
    transport.response = new DeliveryTransportError('TIMEOUT')

    const result = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-timeout',
      transport,
    })

    expect(result.outcome).toBe('retrying')

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true },
    })
    expect(stored.status).toBe('RETRYING')
    expect(stored.statusCode).toBeNull()
    expect(JSON.parse(stored.response ?? '')).toEqual({ error: 'TIMEOUT' })
    expect(stored.attempts[0]?.statusCode).toBeNull()
    expect(JSON.parse(stored.attempts[0]?.response ?? '')).toEqual({
      error: 'TIMEOUT',
    })
  })

  it('marks permanent HTTP failures as FAILED without scheduling a retry', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    const transport = new FakeTransport()
    transport.response = { statusCode: 400, body: 'bad request', truncated: false }

    const result = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-permanent',
      transport,
    })

    expect(result.outcome).toBe('failed')

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })
    expect(stored.status).toBe('FAILED')
    expect(stored.retryCount).toBe(0)
    expect(stored.nextAttempt).toBeNull()
    expect(stored.statusCode).toBe('400')
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()
    expect(stored.attempts[0]?.statusCode).toBe('400')
    expect(stored.outboxRecords[0]?.published).toBe(true)
    expect(stored.outboxRecords[0]?.generation).toBe(0)
  })

  it('does not schedule a retry after the final permitted attempt', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    await prisma.delivery.update({
      where: { id: created.deliveryId },
      data: {
        status: 'RETRYING',
        retryCount: 4,
        nextAttempt: new Date(Date.now() - 1_000),
      },
    })

    const transport = new FakeTransport()
    transport.response = { statusCode: 503, body: 'unavailable', truncated: false }

    const result = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-final-attempt',
      transport,
    })

    expect(result).toEqual({
      deliveryId: created.deliveryId,
      outcome: 'failed',
      attemptCount: 5,
    })

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })
    expect(stored.status).toBe('FAILED')
    expect(stored.retryCount).toBe(4)
    expect(stored.nextAttempt).toBeNull()
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()
    expect(stored.attempts).toHaveLength(1)
    expect(stored.attempts[0]?.attemptCount).toBe(5)
    expect(stored.outboxRecords[0]?.published).toBe(true)
    expect(stored.outboxRecords[0]?.generation).toBe(0)
  })

  it('marks destination-policy rejections as permanent failures', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    const transport = new FakeTransport()
    transport.response = new SsrfError(
      'INVALID_DESTINATION',
      'Destination URL is not allowed',
    )

    const result = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-ssrf',
      transport,
    })

    expect(result.outcome).toBe('failed')

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true },
    })
    expect(stored.status).toBe('FAILED')
    expect(stored.statusCode).toBeNull()
    expect(JSON.parse(stored.response ?? '')).toEqual({
      error: 'DESTINATION_REJECTED',
    })
    expect(stored.attempts[0]?.statusCode).toBeNull()
  })

  it('releases the claim and reschedules after an unexpected internal error', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    const transport = new FakeTransport()
    transport.response = new Error('unexpected transport bug')

    await expect(
      processDeliveryJob(created.deliveryId, {
        workerId: 'worker-internal-error',
        transport,
      }),
    ).rejects.toThrow('unexpected transport bug')

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })
    expect(stored.status).toBe('RETRYING')
    expect(stored.nextAttempt).toBeInstanceOf(Date)
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()
    expect(stored.outboxRecords[0]?.published).toBe(false)
    expect(stored.outboxRecords[0]?.generation).toBe(1)
    expect(stored.attempts).toHaveLength(1)
  })

  it('does not let a late worker overwrite a recovered lease', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    const transport = new FakeTransport()

    let releaseRequest: () => void = () => {}
    transport.gate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })

    let signalRequest: () => void = () => {}
    const requestStarted = new Promise<void>((resolve) => {
      signalRequest = resolve
    })
    transport.onRequest = signalRequest

    const first = processDeliveryJob(created.deliveryId, {
      workerId: 'worker-that-stalled',
      transport,
    })
    await requestStarted

    await prisma.delivery.update({
      where: { id: created.deliveryId },
      data: {
        lockedBy: 'worker-that-stalled',
        lockedUntil: new Date(Date.now() - 1_000),
      },
    })

    const queue = new FakeDeliveryQueue()
    const recovery = await reconcileScheduling({
      queue,
      batchSize: 10,
      now: new Date(),
    })
    expect(recovery.recoveredLeases).toBe(1)

    releaseRequest()
    await expect(first).resolves.toEqual({
      deliveryId: created.deliveryId,
      outcome: 'lost_claim',
      attemptCount: 1,
    })

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true, outboxRecords: true },
    })
    expect(stored.status).toBe('RETRYING')
    expect(stored.retryCount).toBe(1)
    expect(stored.nextAttempt).toBeInstanceOf(Date)
    expect(stored.lockedUntil).toBeNull()
    expect(stored.lockedBy).toBeNull()
    expect(stored.outboxRecords[0]?.published).toBe(false)
    expect(stored.outboxRecords[0]?.generation).toBe(1)
    expect(stored.attempts).toHaveLength(1)
    expect(stored.attempts[0]?.completedAt).toBeInstanceOf(Date)
    expect(stored.attempts[0]?.statusCode).toBe('200')
  })

  it('prevents concurrent workers and duplicate jobs from creating attempts', async () => {
    const created = await createDelivery()
    await publishDelivery(created)
    const transport = new FakeTransport()

    let releaseRequest: () => void = () => {}
    transport.gate = new Promise<void>((resolve) => {
      releaseRequest = resolve
    })

    let signalRequest: () => void = () => {}
    const requestStarted = new Promise<void>((resolve) => {
      signalRequest = resolve
    })
    transport.onRequest = signalRequest

    const first = processDeliveryJob(created.deliveryId, {
      workerId: 'worker-a',
      transport,
    })
    await requestStarted

    const second = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-b',
      transport,
    })
    expect(second).toEqual({
      deliveryId: created.deliveryId,
      outcome: 'skipped',
    })

    releaseRequest()
    await expect(first).resolves.toMatchObject({ outcome: 'succeeded' })

    const duplicate = await processDeliveryJob(created.deliveryId, {
      workerId: 'worker-c',
      transport,
    })
    expect(duplicate).toEqual({
      deliveryId: created.deliveryId,
      outcome: 'skipped',
    })

    const stored = await prisma.delivery.findUniqueOrThrow({
      where: { id: created.deliveryId },
      include: { attempts: true },
    })
    expect(stored.attempts).toHaveLength(1)
    expect(transport.requests).toHaveLength(1)
  })
})
