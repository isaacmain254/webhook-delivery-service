import { z } from 'zod'
import { EVENT_TYPES, eventTypeSchema } from '../lib/events.js'

const destinationUrlSchema = z.url().max(2048)

const endpointIdParamsSchema = z.object({
  id: z.uuid(),
})

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
  params: endpointIdParamsSchema,
})

export const endpointParamsSchema = z.object({
  params: endpointIdParamsSchema,
})

export const updateSubscriptionsRequestSchema = z.object({
  body: z.object({
    events: subscribedEventsSchema,
  }),
  params: endpointIdParamsSchema,
})
