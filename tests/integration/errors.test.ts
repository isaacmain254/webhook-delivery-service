import supertest from 'supertest'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import prisma from '../../src/db.js'
import { createTestApp } from '../helpers/test-app.js'
import { registerUser, uniqueUsername, type TestUser } from '../helpers/users.js'
import { logger } from '../../src/lib/logger.js'

const app = createTestApp()

describe('API validation and error handling', () => {
  let owner: TestUser

  beforeAll(async () => {
    owner = await registerUser(app, uniqueUsername('error-owner'))
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  afterAll(async () => {
    await prisma.user.delete({ where: { id: owner.id } })
    await prisma.$disconnect()
  })

  it('returns a consistent 401 for missing, malformed, and unknown API keys', async () => {
    const expected = {
      error: {
        code: 'UNAUTHORIZED',
        message: 'A valid X-API-Key header is required',
        details: [],
      },
    }

    const missing = await supertest(app).get('/v1/endpoints').expect(401)
    expect(missing.body).toEqual(expected)

    const malformed = await supertest(app)
      .get('/v1/endpoints')
      .set('X-API-Key', 'not-a-valid-key')
      .expect(401)
    expect(malformed.body).toEqual(expected)

    const unknown = await supertest(app)
      .get('/v1/endpoints')
      .set('X-API-Key', 'a'.repeat(64))
      .expect(401)
    expect(unknown.body).toEqual(expected)
  })

  it('returns a JSON 404 for unmatched routes', async () => {
    const response = await supertest(app)
      .get('/v1/does-not-exist')
      .set('X-API-Key', owner.apiKey)
      .expect(404)

    expect(response.body).toEqual({
      error: {
        code: 'NOT_FOUND',
        message: 'Route not found',
        details: [],
      },
    })
  })

  it('validates bodies, route parameters, and query parameters with details', async () => {
    const body = await supertest(app)
      .post('/v1/users')
      .send({ username: 'ab' })
      .expect(422)
    expect(body.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [{ path: 'body.username', message: expect.any(String) }],
      },
    })

    const params = await supertest(app)
      .get('/v1/endpoints/not-a-uuid')
      .set('X-API-Key', owner.apiKey)
      .expect(422)
    expect(params.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [{ path: 'params.id', message: expect.any(String) }],
      },
    })

    const query = await supertest(app)
      .get('/v1/endpoints?unexpected=value')
      .set('X-API-Key', owner.apiKey)
      .expect(422)
    expect(query.body).toMatchObject({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [{ path: 'query.unexpected', message: expect.any(String) }],
      },
    })
  })

  it('returns a safe 400 for malformed JSON', async () => {
    const response = await supertest(app)
      .post('/v1/events')
      .set('X-API-Key', owner.apiKey)
      .set('Content-Type', 'application/json')
      .send('{"idempotencyKey":')
      .expect(400)

    expect(response.body).toEqual({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body is not valid JSON',
        details: [],
      },
    })
  })

  it('maps a duplicate username to a safe 409', async () => {
    const response = await supertest(app)
      .post('/v1/users')
      .send({ username: owner.username })
      .expect(409)

    expect(response.body).toEqual({
      error: {
        code: 'USERNAME_TAKEN',
        message: 'Username is already registered',
        details: [],
      },
    })
  })

  it('enforces both request-size limits with structured 413 responses', async () => {
    const oversizedBody = await supertest(app)
      .post('/v1/events')
      .set('X-API-Key', owner.apiKey)
      .send({
        idempotencyKey: 'oversized-body',
        eventType: 'payment.created',
        payload: { blob: 'x'.repeat(1_200_000) },
      })
      .expect(413)

    expect(oversizedBody.body).toEqual({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the configured limit',
        details: [],
      },
    })

    const oversizedPayload = await supertest(app)
      .post('/v1/events')
      .set('X-API-Key', owner.apiKey)
      .send({
        idempotencyKey: 'oversized-payload',
        eventType: 'payment.created',
        payload: { blob: 'x'.repeat(70_000) },
      })
      .expect(413)

    expect(oversizedPayload.body).toMatchObject({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: expect.stringContaining('Event payload exceeds'),
        details: [
          {
            path: 'body.payload',
            message: expect.stringContaining('maximum is 65536'),
          },
        ],
      },
    })
  })

  it('handles async failures without exposing internals or stack traces', async () => {
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    vi.spyOn(prisma.webhookEndpoint, 'findMany').mockRejectedValue(
      new Error('database password secret-value'),
    )

    const response = await supertest(app)
      .get('/v1/endpoints')
      .set('X-API-Key', owner.apiKey)
      .expect(500)

    expect(logError).toHaveBeenCalled()
    expect(response.body).toEqual({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
      },
    })
    expect(response.text).not.toContain('secret-value')
    expect(response.text).not.toContain('stack')
    expect(response.text).not.toContain('database password')
  })
})
