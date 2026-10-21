import supertest from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import prisma from '../../src/db.js'
import { createTestApp } from '../helpers/test-app.js'

const app = createTestApp()

describe('health endpoints', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports readiness when PostgreSQL and Redis are reachable', async () => {
    const response = await supertest(app).get('/v1/health').expect(200)

    expect(response.body).toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
    })
  })

  it('degrades to 503 when the database is unreachable', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('database offline'))

    const response = await supertest(app).get('/v1/health').expect(503)

    expect(response.body).toEqual({
      status: 'degraded',
      db: 'unavailable',
      redis: 'ok',
    })
  })

  it('never consults dependencies for liveness', async () => {
    vi.spyOn(prisma, '$queryRaw').mockRejectedValue(new Error('database offline'))

    const response = await supertest(app).get('/v1/health/live').expect(200)

    expect(response.body).toEqual({ status: 'ok' })
  })

  it('echoes a client-supplied X-Request-Id in the response header', async () => {
    const response = await supertest(app)
      .get('/v1/health/live')
      .set('X-Request-Id', 'test-request-id-42')
      .expect(200)

    expect(response.headers['x-request-id']).toBe('test-request-id-42')
  })

  it('generates a UUID X-Request-Id when the header is absent', async () => {
    const response = await supertest(app).get('/v1/health/live').expect(200)

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    )
  })
})
