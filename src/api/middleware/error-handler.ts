import type { ErrorRequestHandler, Response } from 'express'
import { ZodError } from 'zod'
import {
  AppError,
  ConflictError,
  PayloadTooLargeError,
  ValidationError,
  zodErrorDetails,
} from '../../lib/errors.js'
import { logger } from '../../lib/logger.js'
import { prismaErrorCode } from '../../lib/prisma-errors.js'

function sendError(res: Response, error: AppError): void {
  res.status(error.statusCode).json({
    error: {
      code: error.code,
      message: error.message,
      details: error.details,
    },
  })
}

/**
 * Normalizes known client and datastore failures. Unknown errors deliberately
 * fall through so they can be logged once and replaced with a generic response.
 */
function normalizeError(error: unknown): AppError | null {
  if (error instanceof AppError) {
    return error
  }

  // Zod errors normally become ValidationError in the request middleware. This
  // fallback keeps any future direct Zod parsing consistent.
  if (error instanceof ZodError) {
    return new ValidationError(zodErrorDetails(error))
  }

  const type = (error as { type?: unknown } | null)?.type
  if (type === 'entity.too.large') {
    return new PayloadTooLargeError('Request body exceeds the configured limit')
  }
  if (type === 'entity.parse.failed') {
    return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON')
  }

  if (prismaErrorCode(error) === 'P2002') {
    return new ConflictError()
  }

  return null
}

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error)
    return
  }

  const knownError = normalizeError(error)
  if (knownError) {
    sendError(res, knownError)
    return
  }

  logger.error(
    { component: 'api', requestId: req.requestId, error },
    '[api] Unhandled error',
  )
  sendError(res, new AppError(500, 'INTERNAL_ERROR', 'Internal server error'))
}
