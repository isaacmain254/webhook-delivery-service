import { z } from 'zod'
import { eventTypeSchema } from '../lib/events.js'

const timestampSchema = z.iso.datetime().meta({
  description: 'ISO 8601 timestamp',
  example: '2026-10-20T12:00:00.000Z',
})

const idSchema = z.uuid().meta({
  description: 'UUID',
  example: '8d8f5d63-0c67-4f49-9b45-a2f63751a6f8',
})

const endpointUrlSchema = z.url().meta({
  description: 'Destination webhook URL',
  example: 'https://example.com/webhooks/payments',
})

const endpointStatusSchema = z.enum(['ACTIVE', 'INACTIVE']).meta({
  description: 'Endpoint delivery state',
  example: 'ACTIVE',
})

const deliveryStatusSchema = z
  .enum(['PENDING', 'PROCESSING', 'RETRYING', 'SUCCEEDED', 'FAILED'])
  .meta({
    description: 'Current delivery state',
    example: 'SUCCEEDED',
  })

const errorDetailSchema = z.object({
  path: z.string().meta({
    description: 'Request location associated with the error',
    example: 'body.username',
  }),
  message: z.string().meta({
    description: 'Human-readable validation message',
    example: 'Too small: expected string to have >=3 characters',
  }),
})

export const errorResponseSchema = z
  .object({
    error: z.object({
      code: z.string().meta({
        description: 'Stable machine-readable error code',
        example: 'VALIDATION_ERROR',
      }),
      message: z.string().meta({
        description: 'Safe human-readable error message',
        example: 'Request validation failed',
      }),
      details: z.array(errorDetailSchema).meta({
        description: 'Field-specific details. Empty when no field-specific detail applies.',
        example: [{ path: 'body.username', message: 'Too small: expected string to have >=3 characters' }],
      }),
    }),
  })
  .meta({ id: 'ErrorResponse', description: 'Standard API error response' })

export const healthStatusSchema = z.enum(['ok', 'unavailable']).meta({
  description: 'Dependency connection state',
  example: 'ok',
})

export const healthResponseSchema = z
  .object({
    status: z.enum(['ok', 'degraded']).meta({
      description: 'Overall readiness. Degraded when any dependency is unreachable.',
      example: 'ok',
    }),
    db: healthStatusSchema,
    redis: healthStatusSchema,
  })
  .meta({ id: 'HealthResponse', description: 'Dependency readiness report' })

export const liveResponseSchema = z
  .object({
    status: z.literal('ok'),
  })
  .meta({ id: 'LiveResponse', description: 'Process liveness report' })

export const userRegistrationResponseSchema = z
  .object({
    id: idSchema,
    username: z.string().meta({ example: 'acme-payments' }),
    apiKey: z.string().meta({
      description: 'API key returned only at registration time. Store it securely.',
      example: '8f14e45fceea167a5a36dedd4bea2543c1f7a8b9d0e1f2a3b4c5d6e7f8a9b0c1',
    }),
  })
  .meta({ id: 'UserRegistrationResponse', description: 'Registered user and its one-time API key' })

const endpointShape = {
  id: idSchema,
  url: endpointUrlSchema,
  status: endpointStatusSchema,
  events: z.array(eventTypeSchema).meta({
    description: 'Subscribed event types',
    example: ['payment.succeeded', 'invoice.paid'],
  }),
  createdOn: timestampSchema,
  updatedOn: timestampSchema,
}

export const endpointResponseSchema = z
  .object(endpointShape)
  .meta({ id: 'Endpoint', description: 'Webhook endpoint' })

export const createdEndpointResponseSchema = z
  .object({
    ...endpointShape,
    signingSecret: z.string().meta({
      description: 'HMAC signing secret returned only when the endpoint is created',
      example: 'whsec_1f2e3d4c5b6a79880716253443526170',
    }),
  })
  .meta({ id: 'CreatedEndpoint', description: 'Newly created webhook endpoint, including its signing secret' })

const eventDeliveryRefSchema = z
  .object({
    id: idSchema,
    endpointId: idSchema,
    status: deliveryStatusSchema,
  })
  .meta({ id: 'EventDeliveryRef', description: 'Delivery created for an event' })

export const eventCreatedResponseSchema = z
  .object({
    id: idSchema,
    eventType: eventTypeSchema,
    idempotencyKey: z.string().meta({ example: 'payment-succeeded-pay_123' }),
    createdOn: timestampSchema,
    deliveries: z.array(eventDeliveryRefSchema),
    replayed: z.boolean().meta({
      description: 'True when an existing identical event was returned instead of created',
      example: false,
    }),
  })
  .meta({ id: 'EventCreatedResponse', description: 'Event ingestion result' })

const deliverySummaryShape = {
  id: idSchema,
  eventId: idSchema,
  endpointId: idSchema,
  status: deliveryStatusSchema,
  retryCount: z.number().int().min(0).meta({
    description: 'Retries already scheduled for the current delivery cycle',
    example: 1,
  }),
  replayCount: z.number().int().min(0).meta({
    description: 'Number of manual replay cycles started for this delivery',
    example: 0,
  }),
  nextAttempt: timestampSchema.nullable().meta({
    description: 'When the delivery becomes eligible for another attempt',
  }),
  statusCode: z.number().int().nullable().meta({
    description: 'HTTP status returned by the destination, when available',
    example: 200,
  }),
  response: z.unknown().nullable().meta({
    description: 'Sanitized response summary from the destination',
  }),
  durationMs: z.number().int().nullable().meta({
    description: 'Duration of the latest attempt in milliseconds',
    example: 142,
  }),
  attemptCount: z.number().int().min(0).meta({
    description: 'Recorded attempts across all replay cycles',
    example: 1,
  }),
}

export const deliverySummarySchema = z
  .object(deliverySummaryShape)
  .meta({ id: 'DeliverySummary', description: 'Delivery state and its latest outcome' })

export const eventDetailResponseSchema = z
  .object({
    id: idSchema,
    eventType: eventTypeSchema,
    idempotencyKey: z.string().meta({ example: 'payment-succeeded-pay_123' }),
    payload: z.record(z.string(), z.unknown()).meta({
      description: 'Original event payload',
      example: { paymentId: 'pay_123', amount: 2500, currency: 'USD' },
    }),
    createdOn: timestampSchema,
    deliveries: z.array(deliverySummarySchema),
  })
  .meta({ id: 'EventDetailResponse', description: 'Stored event with its delivery states' })

export const deliveryDetailResponseSchema = z
  .object({
    ...deliverySummaryShape,
    event: z.object({
      id: idSchema,
      eventType: eventTypeSchema,
      createdOn: timestampSchema,
    }),
    endpoint: z.object({
      id: idSchema,
      url: endpointUrlSchema,
      status: endpointStatusSchema,
    }),
  })
  .meta({ id: 'DeliveryDetailResponse', description: 'Delivery with its event and endpoint context' })

export const deliveryAttemptResponseSchema = z
  .object({
    id: z.number().int().meta({
      description: 'Monotonic attempt identifier',
      example: 42,
    }),
    replayCount: z.number().int().min(0).meta({ example: 0 }),
    attemptCount: z.number().int().min(1).meta({
      description: 'Attempt number within its replay cycle',
      example: 1,
    }),
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    statusCode: z.number().int().nullable().meta({ example: 200 }),
    response: z.unknown().nullable().meta({
      description: 'Sanitized response summary for this attempt',
    }),
    durationMs: z.number().int().nullable().meta({ example: 142 }),
  })
  .meta({ id: 'DeliveryAttempt', description: 'One recorded delivery attempt' })
