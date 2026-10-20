import type { RequestHandler } from 'express'
import { NotFoundError } from '../../lib/errors.js'

/** Converts unmatched routes into the same JSON 404 shape as missing resources. */
export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(new NotFoundError('Route not found'))
}
