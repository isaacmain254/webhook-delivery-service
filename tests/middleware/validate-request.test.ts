import type { Request, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ValidationError } from '../../src/lib/errors.js'
import { validateRequest } from '../../src/api/middleware/validate-request.js'

describe('validateRequest', () => {
  it('passes parsed body, params, and query values to the route handler', async () => {
    const schema = z.object({
      body: z.object({ count: z.coerce.number().default(3) }),
      params: z.object({ id: z.coerce.number() }),
      query: z.object({ enabled: z.enum(['true', 'false']).transform((value) => value === 'true') }),
    })

    const req = { body: {}, params: { id: '42' }, query: { enabled: 'true' } } as unknown as Request
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response
    const next = vi.fn()
    vi.mocked(res.status).mockReturnValue(res)

    validateRequest(schema)(req, res, next)

    expect(req.body).toEqual({ count: 3 })
    expect(req.params).toEqual({ id: 42 })
    expect(req.query).toEqual({ enabled: true })
    expect(next).toHaveBeenCalledOnce()
    expect(res.status).not.toHaveBeenCalled()
  })

  it('forwards a ValidationError and does not call the handler for invalid input', async () => {
    const req = { body: { username: 'ab' }, params: {}, query: {} } as unknown as Request
    const res = { status: vi.fn(), json: vi.fn() } as unknown as Response
    const next = vi.fn()

    validateRequest(z.object({ body: z.object({ username: z.string().min(3) }) }))(req, res, next)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledOnce()

    const error = next.mock.calls[0]?.[0]
    expect(error).toBeInstanceOf(ValidationError)
    expect(error).toMatchObject({
      statusCode: 422,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [{ path: 'body.username', message: expect.any(String) }],
    })
  })
})
