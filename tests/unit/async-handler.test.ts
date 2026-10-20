import type { Request, RequestHandler, Response } from 'express'
import { describe, expect, it, vi } from 'vitest'
import { asyncHandler } from '../../src/api/middleware/async-handler.js'

const req = {} as Request
const res = {} as Response

describe('asyncHandler', () => {
  it('forwards rejected promises to the error middleware', async () => {
    const next = vi.fn()
    const error = new Error('async failure')
    const handler = asyncHandler(async () => {
      throw error
    })

    handler(req, res, next)

    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(error))
  })

  it('forwards synchronous throws to the error middleware', async () => {
    const next = vi.fn()
    const error = new Error('sync failure')
    const handler = asyncHandler((() => {
      throw error
    }) as RequestHandler)

    handler(req, res, next)

    await vi.waitFor(() => expect(next).toHaveBeenCalledWith(error))
  })

  it('does not call next when the handler succeeds', async () => {
    const next = vi.fn()
    const handler = asyncHandler(async () => undefined)

    handler(req, res, next)

    await new Promise((resolve) => setImmediate(resolve))
    expect(next).not.toHaveBeenCalled()
  })
})
