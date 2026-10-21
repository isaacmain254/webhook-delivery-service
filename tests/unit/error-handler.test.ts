import type { Request, Response } from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { errorHandler } from '../../src/api/middleware/error-handler.js'
import {
  AuthError,
  NotFoundError,
  ValidationError,
} from '../../src/lib/errors.js'
import { logger } from '../../src/lib/logger.js'

function createResponse(headersSent = false): {
  res: Response
  status: ReturnType<typeof vi.fn>
  json: ReturnType<typeof vi.fn>
} {
  const status = vi.fn()
  const json = vi.fn()
  const res = { headersSent, status, json } as unknown as Response
  status.mockReturnValue(res)
  return { res, status, json }
}

const req = {} as Request

describe('errorHandler', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('serializes a typed AppError', () => {
    const { res, status, json } = createResponse()
    errorHandler(new NotFoundError('Endpoint not found'), req, res, vi.fn())

    expect(status).toHaveBeenCalledWith(404)
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'NOT_FOUND',
        message: 'Endpoint not found',
        details: [],
      },
    })
  })

  it('serializes validation details', () => {
    const { res, status, json } = createResponse()
    errorHandler(
      new ValidationError([{ path: 'body.username', message: 'Too short' }]),
      req,
      res,
      vi.fn(),
    )

    expect(status).toHaveBeenCalledWith(422)
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [{ path: 'body.username', message: 'Too short' }],
      },
    })
  })

  it('maps a directly surfaced ZodError to a validation response', () => {
    const { res, status, json } = createResponse()
    const parsed = z.object({ name: z.string().min(3) }).safeParse({ name: 'a' })
    if (parsed.success) {
      throw new Error('Expected validation to fail')
    }

    errorHandler(parsed.error, req, res, vi.fn())

    expect(status).toHaveBeenCalledWith(422)
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [{ path: 'name', message: expect.any(String) }],
      },
    })
  })

  it('maps body-parser failures to safe errors', () => {
    const tooLarge = createResponse()
    errorHandler({ type: 'entity.too.large' }, req, tooLarge.res, vi.fn())
    expect(tooLarge.status).toHaveBeenCalledWith(413)
    expect(tooLarge.json).toHaveBeenCalledWith({
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: 'Request body exceeds the configured limit',
        details: [],
      },
    })

    const malformed = createResponse()
    errorHandler({ type: 'entity.parse.failed' }, req, malformed.res, vi.fn())
    expect(malformed.status).toHaveBeenCalledWith(400)
    expect(malformed.json).toHaveBeenCalledWith({
      error: {
        code: 'INVALID_JSON',
        message: 'Request body is not valid JSON',
        details: [],
      },
    })
  })

  it('maps Prisma uniqueness violations without exposing database details', () => {
    const { res, status, json } = createResponse()
    errorHandler(
      { code: 'P2002', meta: { target: ['username'] }, message: 'Unique constraint failed' },
      req,
      res,
      vi.fn(),
    )

    expect(status).toHaveBeenCalledWith(409)
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'CONFLICT',
        message: 'Resource already exists',
        details: [],
      },
    })
    expect(JSON.stringify(json.mock.calls)).not.toContain('username')
    expect(JSON.stringify(json.mock.calls)).not.toContain('Unique constraint')
  })

  it('hides unexpected error details and logs them server-side', () => {
    const logError = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
    const { res, status, json } = createResponse()
    const secret = new Error('database password is secret-value')
    secret.stack = 'SECRET STACK'

    errorHandler(secret, req, res, vi.fn())

    expect(logError).toHaveBeenCalled()
    expect(status).toHaveBeenCalledWith(500)
    expect(json).toHaveBeenCalledWith({
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
        details: [],
      },
    })
    expect(JSON.stringify(json.mock.calls)).not.toContain('secret-value')
    expect(JSON.stringify(json.mock.calls)).not.toContain('SECRET STACK')
  })

  it('defers to Express when response headers were already sent', () => {
    const { res, status, json } = createResponse(true)
    const next = vi.fn()
    const error = new AuthError()

    errorHandler(error, req, res, next)

    expect(next).toHaveBeenCalledWith(error)
    expect(status).not.toHaveBeenCalled()
    expect(json).not.toHaveBeenCalled()
  })
})
