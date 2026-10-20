import { z } from 'zod'
import { EVENT_TYPES, eventTypeSchema } from '../lib/events.js'
import { emptyQuerySchema, uuidParamsSchema } from './common.schema.js'

const destinationUrlSchema = z.url().max(2048)

// `PUT /subscriptions` replaces the whole list, so duplicates are collapsed
// into a single subscription entry instead of being rejected.
const subscribedEventsSchema = z
  .array(eventTypeSchema)
  .max(EVENT_TYPES.length)
  .transform((events) => [...new Set(events)])

export const createEndpointRequestSchema = z.object({
  body: z.object({
    url: destinationUrlSchema,
    events: subscribedEventsSchema.optional(),
  }),
  query: emptyQuerySchema,
})

export const listEndpointsRequestSchema = z.object({
  query: emptyQuerySchema,
})

export const updateEndpointRequestSchema = z.object({
  body: z
    .object({
      url: destinationUrlSchema.optional(),
      status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    })
    .refine((body) => body.url !== undefined || body.status !== undefined, {
      message: 'Provide url and/or status',
    }),
  params: uuidParamsSchema,
  query: emptyQuerySchema,
})

export const endpointParamsSchema = z.object({
  params: uuidParamsSchema,
  query: emptyQuerySchema,
})

export const updateSubscriptionsRequestSchema = z.object({
  body: z.object({
    events: subscribedEventsSchema,
  }),
  params: uuidParamsSchema,
  query: emptyQuerySchema,
})
