import { z } from 'zod'
import { eventTypeSchema } from '../lib/events.js'
import { isJsonCanonicalizable } from '../lib/fingerprint.js'
import { emptyQuerySchema } from './common.schema.js'

// JSON object with values that survive canonical serialization. Rejects
// non-finite numbers (for example `1e400` parses to Infinity) before they can
// reach the database.
export const eventPayloadSchema = z
  .record(z.string(), z.unknown())
  .refine((payload) => isJsonCanonicalizable(payload), {
    message: 'Payload must contain only finite JSON values',
  })
  .meta({
    description:
      'Arbitrary JSON object delivered to subscribed endpoints. The canonical payload must not exceed MAX_EVENT_PAYLOAD_BYTES.',
    example: {
      paymentId: 'pay_01HZY4R8K4Q2M5N6P7R8S9T0V1',
      amount: 2500,
      currency: 'USD',
    },
  })

export const createEventBodySchema = z
  .object({
    idempotencyKey: z.string().min(1).max(256).meta({
      description:
        'Caller-supplied key unique within the authenticated user. Reusing a key with a different event type or payload returns 409.',
      example: 'payment-succeeded-pay_01HZY4R8K4Q2M5N6P7R8S9T0V1',
    }),
    eventType: eventTypeSchema,
    payload: eventPayloadSchema,
  })
  .meta({ id: 'CreateEventBody', description: 'Event ingestion request' })

export const createEventRequestSchema = z.object({
  body: createEventBodySchema,
  query: emptyQuerySchema,
})
