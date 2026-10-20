import { z } from 'zod'
import { EVENT_TYPES, eventTypeSchema } from '../lib/events.js'
import { emptyQuerySchema, uuidParamsSchema } from './common.schema.js'

export const destinationUrlSchema = z.url().max(2048).meta({
  description: 'HTTPS URL that receives signed webhook requests',
  example: 'https://example.com/webhooks/payments',
})

// `PUT /subscriptions` replaces the whole list, so duplicates are collapsed
// into a single subscription entry instead of being rejected.
export const subscribedEventsSchema = z
  .array(eventTypeSchema)
  .max(EVENT_TYPES.length)
  .transform((events) => [...new Set(events)])
  .meta({
    description: 'Event types to deliver to this endpoint. Duplicate values are collapsed.',
    example: ['payment.succeeded', 'invoice.paid'],
  })

export const createEndpointBodySchema = z
  .object({
    url: destinationUrlSchema,
    events: subscribedEventsSchema.optional(),
  })
  .meta({ id: 'CreateEndpointBody', description: 'Webhook endpoint registration' })

export const updateEndpointBodySchema = z
  .object({
    url: destinationUrlSchema.optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional().meta({
      description: 'Whether the endpoint should receive new deliveries',
      example: 'ACTIVE',
    }),
  })
  .refine((body) => body.url !== undefined || body.status !== undefined, {
    message: 'Provide url and/or status',
  })
  .meta({ id: 'UpdateEndpointBody', description: 'Fields to update on a webhook endpoint' })

export const updateSubscriptionsBodySchema = z
  .object({
    events: subscribedEventsSchema,
  })
  .meta({ id: 'UpdateSubscriptionsBody', description: 'Replacement subscription list' })

export const createEndpointRequestSchema = z.object({
  body: createEndpointBodySchema,
  query: emptyQuerySchema,
})

export const listEndpointsRequestSchema = z.object({
  query: emptyQuerySchema,
})

export const updateEndpointRequestSchema = z.object({
  body: updateEndpointBodySchema,
  params: uuidParamsSchema,
  query: emptyQuerySchema,
})

export const endpointParamsSchema = z.object({
  params: uuidParamsSchema,
  query: emptyQuerySchema,
})

export const updateSubscriptionsRequestSchema = z.object({
  body: updateSubscriptionsBodySchema,
  params: uuidParamsSchema,
  query: emptyQuerySchema,
})
