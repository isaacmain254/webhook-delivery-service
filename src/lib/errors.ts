import type { ZodError } from 'zod'

export interface ErrorDetail {
  path: string
  message: string
}

/** Base class for errors whose message and details are safe to return to clients. */
export class AppError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly details: ErrorDetail[]

  constructor(
    statusCode: number,
    code: string,
    message: string,
    details: ErrorDetail[] = [],
  ) {
    super(message)
    this.name = new.target.name
    this.statusCode = statusCode
    this.code = code
    this.details = details
  }
}

export class ValidationError extends AppError {
  constructor(details: ErrorDetail[]) {
    super(422, 'VALIDATION_ERROR', 'Request validation failed', details)
  }
}

export class AuthError extends AppError {
  constructor(message = 'A valid X-API-Key header is required') {
    super(401, 'UNAUTHORIZED', message)
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Resource not found') {
    super(404, 'NOT_FOUND', message)
  }
}

export class ConflictError extends AppError {
  constructor(
    code = 'CONFLICT',
    message = 'Resource already exists',
    details: ErrorDetail[] = [],
  ) {
    super(409, code, message, details)
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Access is forbidden') {
    super(403, 'FORBIDDEN', message)
  }
}

export class PayloadTooLargeError extends AppError {
  constructor(message = 'Request body exceeds the configured limit', details: ErrorDetail[] = []) {
    super(413, 'PAYLOAD_TOO_LARGE', message, details)
  }
}

/** Converts Zod issues into the stable detail format used by the API. */
export function zodErrorDetails(error: ZodError): ErrorDetail[] {
  return error.issues.map((issue) => {
    const path = [...issue.path]
    if (issue.code === 'unrecognized_keys') {
      path.push(...issue.keys)
    }

    return {
      path: path.join('.'),
      message: issue.message,
    }
  })
}
