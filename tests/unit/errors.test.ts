import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  AppError,
  AuthError,
  ConflictError,
  ForbiddenError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
  zodErrorDetails,
} from '../../src/lib/errors.js'
import { SsrfError } from '../../src/lib/ssrf.js'

describe('typed API errors', () => {
  it('carries safe status, code, message, and details', () => {
    const error = new AppError(418, 'TEAPOT', 'Short and stout', [
      { path: 'body', message: 'not a teapot' },
    ])

    expect(error).toMatchObject({
      name: 'AppError',
      statusCode: 418,
      code: 'TEAPOT',
      message: 'Short and stout',
      details: [{ path: 'body', message: 'not a teapot' }],
    })
  })

  it('defines the standard client-error subclasses', () => {
    expect(new ValidationError([{ path: 'body.x', message: 'invalid' }])).toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      details: [{ path: 'body.x', message: 'invalid' }],
    })
    expect(new AuthError()).toMatchObject({ statusCode: 401, code: 'UNAUTHORIZED', details: [] })
    expect(new NotFoundError()).toMatchObject({ statusCode: 404, code: 'NOT_FOUND', details: [] })
    expect(new ConflictError('USERNAME_TAKEN', 'Taken')).toMatchObject({
      statusCode: 409,
      code: 'USERNAME_TAKEN',
      message: 'Taken',
      details: [],
    })
    expect(new ForbiddenError()).toMatchObject({ statusCode: 403, code: 'FORBIDDEN', details: [] })
    expect(new PayloadTooLargeError()).toMatchObject({
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      details: [],
    })
  })

  it('keeps SSRF failures in the central error hierarchy', () => {
    const error = new SsrfError('HTTPS_REQUIRED', 'Destination URL must use HTTPS')

    expect(error).toBeInstanceOf(AppError)
    expect(error).toMatchObject({
      statusCode: 422,
      code: 'HTTPS_REQUIRED',
      message: 'Destination URL must use HTTPS',
      details: [],
    })
  })

  it('converts Zod issues into stable error details', () => {
    const result = z
      .object({ name: z.string().min(3), count: z.number() })
      .safeParse({ name: 'a', count: 'nope' })

    expect(result.success).toBe(false)
    if (result.success) {
      return
    }

    expect(zodErrorDetails(result.error)).toEqual([
      { path: 'name', message: expect.any(String) },
      { path: 'count', message: expect.any(String) },
    ])
  })
})
