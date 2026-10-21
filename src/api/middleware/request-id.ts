import { randomUUID } from 'node:crypto'
import type { RequestHandler } from 'express'

/**
 * Assigns one correlation identifier per request: an inbound `X-Request-Id`
 * header is honored (trimmed) when supplied, otherwise a UUID is generated.
 * Identifier is echoed on the response so clients and logs can be joined by
 * reading either side.
 */
export const assignRequestId: RequestHandler = (req, res, next) => {
  if (req.requestId) {
    next()
    return
  }

  const inbound = req.headers['x-request-id']
  const requestId =
    typeof inbound === 'string' && inbound.trim().length > 0
      ? inbound.trim()
      : randomUUID()

  req.requestId = requestId
  res.setHeader('X-Request-Id', requestId)
  next()
}
