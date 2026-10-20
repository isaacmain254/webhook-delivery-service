import type { ErrorRequestHandler } from 'express'

/**
 * Minimal error handler introduced with event ingestion so oversized requests
 * and malformed JSON map to structured responses. Task 11 replaces this with
 * the full validation/error-handling layer.
 */
export const errorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (res.headersSent) {
    next(error)
    return
  }

  const type = (error as { type?: unknown } | null)?.type

  if (type === 'entity.too.large') {
    res.status(413).json({
      error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body exceeds the configured limit' },
    })
    return
  }

  if (type === 'entity.parse.failed') {
    res.status(400).json({
      error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' },
    })
    return
  }

  console.error('[api] Unhandled error:', error)
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
  })
}
