import { z } from 'zod'
import { eventTypeSchema } from '../lib/events.js'
import { isJsonCanonicalizable } from '../lib/fingerprint.js'
import { emptyQuerySchema } from './common.schema.js'

// JSON object with values that survive canonical serialization. Rejects
// non-finite numbers (for example `1e400` parses to Infinity) before they can
// reach the database.
const payloadSchema = z
  .record(z.string(), z.unknown())
  .refine((payload) => isJsonCanonicalizable(payload), {
    message: 'Payload must contain only finite JSON values',
  })

export const createEventRequestSchema = z.object({
  body: z.object({
    idempotencyKey: z.string().min(1).max(256),
    eventType: eventTypeSchema,
    payload: payloadSchema,
  }),
  query: emptyQuerySchema,
})
