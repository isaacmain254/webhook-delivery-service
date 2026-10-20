import supertest from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import prisma from '../../src/db.js'
import { createTestApp } from '../helpers/test-app.js'
import { registerUser, uniqueUsername, type TestUser } from '../helpers/users.js'

const app = createTestApp()
const publicHost = 'https://93.184.216.34'

interface EndpointSummary {
  id: string
  events: string[]
}

async function createEndpoint(apiKey: string, body: Record<string, unknown>): Promise<EndpointSummary> {
  const response = await supertest(app).post('/v1/endpoints').set('X-API-Key', apiKey).send(body)

  if (response.status !== 201) {
    throw new Error(`Failed to create endpoint (${response.status}): ${JSON.stringify(response.body)}`)
  }

  return response.body as EndpointSummary
}

function postEvent(apiKey: string, body: Record<string, unknown>) {
  return supertest(app).post('/v1/events').set('X-API-Key', apiKey).send(body)
}

describe('event ingestion API', () => {
  let owner: TestUser
  let other: TestUser
  const userIds: string[] = []

  beforeAll(async () => {
    owner = await registerUser(app, uniqueUsername('event-owner'))
    other = await registerUser(app, uniqueUsername('event-other'))
    userIds.push(owner.id, other.id)
  })

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('requires authentication', async () => {
    await supertest(app)
      .post('/v1/events')
      .send({ idempotencyKey: 'k', eventType: 'payment.created', payload: {} })
      .expect(401)
  })

  it('rejects invalid submissions', async () => {
    const base = {
      idempotencyKey: 'invalid-key',
      eventType: 'payment.created',
      payload: { amount: 1 },
    }

    await postEvent(owner.apiKey, { ...base, eventType: 'not.a.real.event' }).expect(422)
    await postEvent(owner.apiKey, { ...base, idempotencyKey: '' }).expect(422)
    await postEvent(owner.apiKey, { ...base, idempotencyKey: 'x'.repeat(257) }).expect(422)
    await postEvent(owner.apiKey, { ...base, payload: [1, 2, 3] }).expect(422)
    await postEvent(owner.apiKey, { ...base, payload: 'not-an-object' }).expect(422)

    const missingPayload = await postEvent(owner.apiKey, {
      idempotencyKey: 'invalid-key',
      eventType: 'payment.created',
    }).expect(422)
    expect(missingPayload.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects payloads that are not canonicalizable JSON', async () => {
    // Raw body: JSON.parse turns 1e400 into Infinity, which would not survive
    // a JSONB round-trip.
    const response = await supertest(app)
      .post('/v1/events')
      .set('X-API-Key', owner.apiKey)
      .set('Content-Type', 'application/json')
      .send('{"idempotencyKey":"non-finite","eventType":"payment.created","payload":{"amount":1e400}}')
      .expect(422)

    expect(response.body.error.code).toBe('VALIDATION_ERROR')
  })

  it('creates the event, fans out deliveries, and writes outbox records atomically', async () => {
    const subscribed = await createEndpoint(owner.apiKey, {
      url: `${publicHost}/events-a`,
      events: ['payment.succeeded', 'payment.failed'],
    })
    await createEndpoint(owner.apiKey, {
      url: `${publicHost}/events-b`,
      events: ['invoice.paid'],
    })
    const inactive = await createEndpoint(owner.apiKey, {
      url: `${publicHost}/events-c`,
      events: ['payment.succeeded'],
    })
    await supertest(app)
      .patch(`/v1/endpoints/${inactive.id}`)
      .set('X-API-Key', owner.apiKey)
      .send({ status: 'INACTIVE' })
      .expect(200)

    const foreign = await createEndpoint(other.apiKey, {
      url: `${publicHost}/events-d`,
      events: ['payment.succeeded'],
    })

    const payload = { amount: 1000, currency: 'usd' }
    const response = await postEvent(owner.apiKey, {
      idempotencyKey: 'order-1-payment-succeeded',
      eventType: 'payment.succeeded',
      payload,
    }).expect(202)

    expect(response.headers['x-idempotency-replay']).toBeUndefined()
    expect(response.body).toMatchObject({
      eventType: 'payment.succeeded',
      idempotencyKey: 'order-1-payment-succeeded',
      replayed: false,
    })

    // Only the ACTIVE endpoint subscribed to payment.succeeded gets a delivery.
    const deliveredEndpointIds = response.body.deliveries.map(
      (delivery: { endpointId: string }) => delivery.endpointId,
    )
    expect(deliveredEndpointIds).toEqual([subscribed.id])
    expect(deliveredEndpointIds).not.toContain(inactive.id)
    expect(deliveredEndpointIds).not.toContain(foreign.id)

    const storedEvent = await prisma.event.findUniqueOrThrow({
      where: { id: response.body.id },
      select: { userId: true, payload: true },
    })
    expect(storedEvent.userId).toBe(owner.id)
    expect(storedEvent.payload).toEqual(payload)

    const delivery = await prisma.delivery.findUniqueOrThrow({
      where: { id: response.body.deliveries[0].id },
    })
    expect(delivery).toMatchObject({
      userId: owner.id,
      endpointId: subscribed.id,
      status: 'PENDING',
      retryCount: 0,
    })
    expect(delivery.nextAttempt).not.toBeNull()

    const outboxRecords = await prisma.outboxRecord.findMany({
      where: { deliveryId: delivery.id },
    })
    expect(outboxRecords).toHaveLength(1)
    expect(outboxRecords[0].published).toBe(false)
    expect(outboxRecords[0].publishedAt).toBeNull()
  })

  it('accepts events with no matching endpoints without creating work', async () => {
    const response = await postEvent(owner.apiKey, {
      idempotencyKey: 'no-matching-endpoints',
      eventType: 'payout.paid',
      payload: { payoutId: 'po-1' },
    }).expect(202)

    expect(response.body.deliveries).toEqual([])
    expect(await prisma.delivery.count({ where: { eventId: response.body.id } })).toBe(0)
    expect(
      await prisma.outboxRecord.count({ where: { delivery: { eventId: response.body.id } } }),
    ).toBe(0)
  })

  it('returns the existing event for an idempotent replay regardless of key order', async () => {
    const first = await postEvent(owner.apiKey, {
      idempotencyKey: 'replay-key',
      eventType: 'payment.created',
      payload: { amount: 1000, meta: { reference: 'ref-1', currency: 'usd' } },
    }).expect(202)

    const second = await postEvent(owner.apiKey, {
      idempotencyKey: 'replay-key',
      eventType: 'payment.created',
      payload: { meta: { currency: 'usd', reference: 'ref-1' }, amount: 1000 },
    }).expect(200)

    expect(second.headers['x-idempotency-replay']).toBe('true')
    expect(second.body.replayed).toBe(true)
    expect(second.body.id).toBe(first.body.id)

    expect(
      await prisma.event.count({
        where: { userId: owner.id, idempotencyKey: 'replay-key' },
      }),
    ).toBe(1)
  })

  it('returns 409 when the key is reused with a different payload or event type', async () => {
    await postEvent(owner.apiKey, {
      idempotencyKey: 'conflict-key',
      eventType: 'payment.created',
      payload: { amount: 1000 },
    }).expect(202)

    const differentPayload = await postEvent(owner.apiKey, {
      idempotencyKey: 'conflict-key',
      eventType: 'payment.created',
      payload: { amount: 2000 },
    }).expect(409)
    expect(differentPayload.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED')

    await postEvent(owner.apiKey, {
      idempotencyKey: 'conflict-key',
      eventType: 'payment.failed',
      payload: { amount: 1000 },
    }).expect(409)

    expect(
      await prisma.event.count({
        where: { userId: owner.id, idempotencyKey: 'conflict-key' },
      }),
    ).toBe(1)
  })

  it('scopes idempotency keys to the authenticated user', async () => {
    const request = {
      idempotencyKey: 'shared-key',
      eventType: 'payment.created',
      payload: { amount: 42 },
    }

    const first = await postEvent(owner.apiKey, request).expect(202)
    const second = await postEvent(other.apiKey, request).expect(202)

    expect(second.body.id).not.toBe(first.body.id)
  })

  it('handles concurrent identical submissions idempotently', async () => {
    const endpoint = await createEndpoint(owner.apiKey, {
      url: `${publicHost}/concurrent`,
      events: ['invoice.created'],
    })

    const request = {
      idempotencyKey: 'concurrent-key',
      eventType: 'invoice.created',
      payload: { invoiceId: 'inv-1', total: 500 },
    }

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => postEvent(owner.apiKey, request)),
    )

    const created = responses.filter((response) => response.status === 202)
    const replayed = responses.filter((response) => response.status === 200)

    expect(created).toHaveLength(1)
    expect(replayed).toHaveLength(4)
    for (const response of replayed) {
      expect(response.headers['x-idempotency-replay']).toBe('true')
      expect(response.body.replayed).toBe(true)
    }

    const eventIds = new Set(responses.map((response) => response.body.id))
    expect(eventIds.size).toBe(1)

    expect(
      await prisma.event.count({
        where: { userId: owner.id, idempotencyKey: 'concurrent-key' },
      }),
    ).toBe(1)

    const deliveries = await prisma.delivery.findMany({
      where: { eventId: [...eventIds][0] },
    })
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0].endpointId).toBe(endpoint.id)

    expect(
      await prisma.outboxRecord.count({ where: { deliveryId: deliveries[0].id } }),
    ).toBe(1)
  })

  it('resolves a duplicate insert race through the unique constraint', async () => {
    const request = {
      idempotencyKey: 'race-key',
      eventType: 'payment.created',
      payload: { amount: 7 },
    }

    const first = await postEvent(owner.apiKey, request).expect(202)

    // Simulate the pre-check missing the committed row (the concurrent case).
    // The insert then fails with P2002 and the service must recover by
    // fetching the winner and comparing fingerprints.
    const spy = vi.spyOn(prisma.event, 'findUnique').mockResolvedValueOnce(null)

    const second = await postEvent(owner.apiKey, request).expect(200)
    expect(second.headers['x-idempotency-replay']).toBe('true')
    expect(second.body.id).toBe(first.body.id)

    // One mocked (missed) pre-check plus the recovery fetch after P2002.
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2)

    expect(
      await prisma.event.count({
        where: { userId: owner.id, idempotencyKey: request.idempotencyKey },
      }),
    ).toBe(1)
  })

  it('rejects event payloads over the configured limit with 413', async () => {
    const response = await postEvent(owner.apiKey, {
      idempotencyKey: 'oversized-payload',
      eventType: 'payment.created',
      payload: { blob: 'x'.repeat(70_000) },
    }).expect(413)

    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })

  it('rejects request bodies over the JSON body limit with 413', async () => {
    const response = await postEvent(owner.apiKey, {
      idempotencyKey: 'oversized-body',
      eventType: 'payment.created',
      payload: { blob: 'x'.repeat(1_200_000) },
    }).expect(413)

    expect(response.body.error.code).toBe('PAYLOAD_TOO_LARGE')
  })
})
