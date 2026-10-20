import type { RequestHandler } from 'express'
import { z } from 'zod'
import { ValidationError, zodErrorDetails } from '../../lib/errors.js'

const requestSections = ['body', 'params', 'query'] as const
type RequestSection = (typeof requestSections)[number]

type RequestSchema = z.ZodType<Partial<Record<RequestSection, unknown>>>

function replaceRequestSection(req: Parameters<RequestHandler>[0], section: RequestSection, value: unknown): void {
  // Express 5 exposes `query` through a getter. Define the parsed value directly
  // so schemas with transforms/defaults work for all request sections.
  Object.defineProperty(req, section, {
    configurable: true,
    enumerable: true,
    writable: true,
    value,
  })
}

export function validateRequest(schema: RequestSchema): RequestHandler {
  return (req, res, next) => {
    const parsed = schema.safeParse({
      body: req.body,
      params: req.params,
      query: req.query,
    })

    if (!parsed.success) {
      next(new ValidationError(zodErrorDetails(parsed.error)))
      return
    }

    for (const section of requestSections) {
      if (Object.prototype.hasOwnProperty.call(parsed.data, section)) {
        replaceRequestSection(req, section, parsed.data[section])
      }
    }

    next()
  }
}
