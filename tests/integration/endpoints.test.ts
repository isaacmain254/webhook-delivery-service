import supertest from 'supertest'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import prisma from '../../src/db.js'
import { createTestApp } from '../helpers/test-app.js'
import { registerUser, uniqueUsername, type TestUser } from '../helpers/users.js'

const app = createTestApp()
const publicHost = 'https://93.184.216.34'

function createEndpoint(apiKey: string, body: Record<string, unknown>) {
  return supertest(app).post('/v1/endpoints').set('X-API-Key', apiKey).send(body)
}

describe('endpoint management API', () => {
  let owner: TestUser
  let other: TestUser
  const userIds: string[] = []

  beforeAll(async () => {
    owner = await registerUser(app, uniqueUsername('endpoint-owner'))
    other = await registerUser(app, uniqueUsername('endpoint-other'))
    userIds.push(owner.id, other.id)
  })

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } })
    await prisma.$disconnect()
  })

  it('requires a valid API key for every endpoint route', async () => {
    await supertest(app).get('/v1/endpoints').expect(401)
    await supertest(app).get('/v1/endpoints').set('X-API-Key', 'not-a-valid-key').expect(401)
    await createEndpoint('not-a-valid-key', { url: `${publicHost}/hooks` }).expect(401)
  })

  it('registers an endpoint and returns the signing secret only once', async () => {
    const response = await createEndpoint(owner.apiKey, {
      url: `${publicHost}/hooks`,
      events: ['payment.created', 'payment.succeeded', 'payment.created'],
    }).expect(201)

    expect(response.body).toMatchObject({ url: `${publicHost}/hooks`, status: 'ACTIVE' })
    expect(response.body.events).toEqual(['payment.created', 'payment.succeeded'])
    expect(response.body.signingSecret).toMatch(/^[a-f0-9]{64}$/)

    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: response.body.id },
      select: { owner: true, signingSecret: true },
    })
    expect(stored.owner).toBe(owner.id)
    expect(stored.signingSecret).toBe(response.body.signingSecret)
  })

  it('creates endpoints without subscriptions by default', async () => {
    const response = await createEndpoint(owner.apiKey, { url: `${publicHost}/no-events` }).expect(
      201,
    )

    expect(response.body.events).toEqual([])
    expect(await prisma.subscription.count({ where: { endpointId: response.body.id } })).toBe(0)
  })

  it('rejects invalid create payloads', async () => {
    await createEndpoint(owner.apiKey, { events: ['payment.created'] }).expect(422)
    await createEndpoint(owner.apiKey, { url: 'not-a-url' }).expect(422)
    await createEndpoint(owner.apiKey, {
      url: `${publicHost}/hooks`,
      events: ['not.a.real.event'],
    }).expect(422)
  })

  it('lists only the authenticated user’s endpoints without signing secrets', async () => {
    const own = (await createEndpoint(owner.apiKey, { url: `${publicHost}/list-own` }).expect(201))
      .body
    const otherEndpoint = (
      await createEndpoint(other.apiKey, { url: `${publicHost}/list-other` }).expect(201)
    ).body

    const response = await supertest(app)
      .get('/v1/endpoints')
      .set('X-API-Key', owner.apiKey)
      .expect(200)

    const ids = response.body.map((endpoint: { id: string }) => endpoint.id)
    expect(ids).toContain(own.id)
    expect(ids).not.toContain(otherEndpoint.id)

    for (const endpoint of response.body) {
      expect(endpoint).not.toHaveProperty('signingSecret')
      expect(endpoint).toHaveProperty('events')
    }
  })

  it('returns a single owned endpoint without the signing secret', async () => {
    const created = (await createEndpoint(owner.apiKey, { url: `${publicHost}/get-me` }).expect(201))
      .body

    const response = await supertest(app)
      .get(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', owner.apiKey)
      .expect(200)

    expect(response.body).toMatchObject({ id: created.id, url: `${publicHost}/get-me` })
    expect(response.body).not.toHaveProperty('signingSecret')
  })

  it('rejects malformed ids and returns 404 for unknown ids', async () => {
    await supertest(app)
      .get('/v1/endpoints/not-a-uuid')
      .set('X-API-Key', owner.apiKey)
      .expect(422)

    await supertest(app)
      .get('/v1/endpoints/00000000-0000-4000-8000-000000000000')
      .set('X-API-Key', owner.apiKey)
      .expect(404)
  })

  it('rejects prohibited destinations without persisting them', async () => {
    const http = await createEndpoint(owner.apiKey, { url: 'http://93.184.216.34/hooks' }).expect(
      422,
    )
    expect(http.body.error.code).toBe('HTTPS_REQUIRED')

    const prohibited = [
      'https://127.0.0.1/hooks',
      'https://10.0.0.5/hooks',
      'https://169.254.169.254/latest/meta-data',
      'https://metadata.google.internal/hooks',
    ]

    for (const url of prohibited) {
      const response = await createEndpoint(owner.apiKey, { url }).expect(422)
      expect(response.body.error.code).toBe('INVALID_DESTINATION')
    }

    const persisted = await prisma.webhookEndpoint.count({
      where: { url: { in: [...prohibited, 'http://93.184.216.34/hooks'] } },
    })
    expect(persisted).toBe(0)
  })

  it('updates the URL and status and revalidates new URLs', async () => {
    const created = (await createEndpoint(owner.apiKey, { url: `${publicHost}/patch-me` }).expect(
      201,
    )).body

    const inactive = await supertest(app)
      .patch(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', owner.apiKey)
      .send({ status: 'INACTIVE' })
      .expect(200)
    expect(inactive.body.status).toBe('INACTIVE')
    expect(inactive.body).not.toHaveProperty('signingSecret')

    const updated = await supertest(app)
      .patch(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', owner.apiKey)
      .send({ url: `${publicHost}/patched` })
      .expect(200)
    expect(updated.body.url).toBe(`${publicHost}/patched`)

    const rejected = await supertest(app)
      .patch(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', owner.apiKey)
      .send({ url: 'https://10.0.0.1/hooks' })
      .expect(422)
    expect(rejected.body.error.code).toBe('INVALID_DESTINATION')

    await supertest(app)
      .patch(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', owner.apiKey)
      .send({})
      .expect(422)
  })

  it('replaces the subscription list and deduplicates events', async () => {
    const created = (await createEndpoint(owner.apiKey, {
      url: `${publicHost}/subscriptions`,
      events: ['payment.created', 'payment.refunded'],
    }).expect(201)).body

    const replaced = await supertest(app)
      .put(`/v1/endpoints/${created.id}/subscriptions`)
      .set('X-API-Key', owner.apiKey)
      .send({ events: ['invoice.paid', 'invoice.paid', 'payout.paid'] })
      .expect(200)
    expect(replaced.body.events).toEqual(['invoice.paid', 'payout.paid'])

    const stored = await prisma.subscription.findUniqueOrThrow({
      where: { endpointId: created.id },
      select: { event: true },
    })
    expect(stored.event).toEqual(['invoice.paid', 'payout.paid'])

    const cleared = await supertest(app)
      .put(`/v1/endpoints/${created.id}/subscriptions`)
      .set('X-API-Key', owner.apiKey)
      .send({ events: [] })
      .expect(200)
    expect(cleared.body.events).toEqual([])

    await supertest(app)
      .put(`/v1/endpoints/${created.id}/subscriptions`)
      .set('X-API-Key', owner.apiKey)
      .send({ events: ['not.a.real.event'] })
      .expect(422)
  })

  it('does not expose or mutate another user’s endpoint', async () => {
    const created = (await createEndpoint(owner.apiKey, { url: `${publicHost}/private` }).expect(201))
      .body

    await supertest(app)
      .get(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', other.apiKey)
      .expect(404)

    await supertest(app)
      .patch(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', other.apiKey)
      .send({ status: 'INACTIVE' })
      .expect(404)

    await supertest(app)
      .put(`/v1/endpoints/${created.id}/subscriptions`)
      .set('X-API-Key', other.apiKey)
      .send({ events: ['payment.created'] })
      .expect(404)

    await supertest(app)
      .delete(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', other.apiKey)
      .expect(404)

    const stored = await prisma.webhookEndpoint.findUniqueOrThrow({
      where: { id: created.id },
      select: { status: true, subscriptions: true },
    })
    expect(stored.status).toBe('ACTIVE')
    expect(stored.subscriptions).toEqual([])
  })

  it('deletes an owned endpoint and cascades to its subscriptions', async () => {
    const created = (await createEndpoint(owner.apiKey, {
      url: `${publicHost}/delete-me`,
      events: ['payment.failed'],
    }).expect(201)).body

    await supertest(app)
      .delete(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', owner.apiKey)
      .expect(204)

    await supertest(app)
      .get(`/v1/endpoints/${created.id}`)
      .set('X-API-Key', owner.apiKey)
      .expect(404)

    expect(await prisma.webhookEndpoint.count({ where: { id: created.id } })).toBe(0)
    expect(await prisma.subscription.count({ where: { endpointId: created.id } })).toBe(0)
  })
})
