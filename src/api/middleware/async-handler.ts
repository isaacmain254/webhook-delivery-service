import type { RequestHandler } from 'express'

/**
 * Forwards rejected promises and synchronous throws from async route handlers
 * into the central Express error middleware.
 */
export function asyncHandler(handler: RequestHandler): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(next)
  }
}
