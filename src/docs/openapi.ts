import { OpenAPIRegistry, OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi'
import { z } from 'zod'
import { createEventBodySchema } from '../schemas/event.schema.js'
import {
  createEndpointBodySchema,
  updateEndpointBodySchema,
  updateSubscriptionsBodySchema,
} from '../schemas/endpoint.schema.js'
import { createUserBodySchema } from '../schemas/user.schema.js'
import {
  createdEndpointResponseSchema,
  deliveryAttemptResponseSchema,
  deliveryDetailResponseSchema,
  deliverySummarySchema,
  endpointResponseSchema,
  errorResponseSchema,
  eventCreatedResponseSchema,
  eventDetailResponseSchema,
  healthResponseSchema,
  liveResponseSchema,
  userRegistrationResponseSchema,
} from './schemas.js'


type JsonSchema = z.ZodType

function jsonResponse(description: string, schema: JsonSchema, example?: unknown) {
  return {
    description,
    content: {
      'application/json': {
        schema,
        ...(example !== undefined ? { example } : {}),
      },
    },
  }
}

function jsonBody(description: string, schema: JsonSchema, example: unknown) {
  return {
    description,
    required: true,
    content: {
      'application/json': {
        schema,
        example,
      },
    },
  }
}

function noContent(description: string) {
  return { description }
}

interface ErrorResponses {
  unauthorized?: boolean
  notFound?: boolean
  conflict?: string
  badRequest?: boolean
  payloadTooLarge?: boolean
  validation?: boolean
  internal?: boolean
}

function errorResponses(errorResponseSchema: JsonSchema, options: ErrorResponses = {}) {
  const errors: Record<string, ReturnType<typeof jsonResponse>> = {}

  if (options.badRequest) {
    errors[400] = jsonResponse('Malformed JSON request body', errorResponseSchema)
  }
  if (options.unauthorized) {
    errors[401] = jsonResponse('Missing or invalid X-API-Key', errorResponseSchema)
  }
  if (options.notFound) {
    errors[404] = jsonResponse(
      'Resource not found or not owned by the authenticated user',
      errorResponseSchema,
    )
  }
  if (options.conflict) {
    errors[409] = jsonResponse(options.conflict, errorResponseSchema)
  }
  if (options.payloadTooLarge) {
    errors[413] = jsonResponse(
      'Request body or canonical event payload exceeds its configured limit',
      errorResponseSchema,
    )
  }
  if (options.validation !== false) {
    errors[422] = jsonResponse('Request validation failed', errorResponseSchema)
  }
  if (options.internal !== false) {
    errors[500] = jsonResponse('Unexpected server error', errorResponseSchema)
  }

  return errors
}

function buildDocument() {
  const registry = new OpenAPIRegistry()

  const standardErrors = (options: ErrorResponses = {}) =>
    errorResponses(errorResponseSchema, options)
  const apiKeySecurity = [{ ApiKeyAuth: [] }]

  registry.registerComponent('securitySchemes', 'ApiKeyAuth', {
    type: 'apiKey',
    in: 'header',
    name: 'X-API-Key',
    description:
      'API key returned by POST /users. Send the full key in the X-API-Key header on every protected request.',
  })

  const resourceIdParams = z.object({
    id: z.uuid().meta({
      param: {
        name: 'id',
        in: 'path',
      },
      description: 'Resource UUID',
      example: '8d8f5d63-0c67-4f49-9b45-a2f63751a6f8',
    }),
  })

  registry.registerPath({
    method: 'get',
    path: '/health',
    operationId: 'getHealth',
    tags: ['Health'],
    summary: 'Check service readiness',
    description:
      'Pings PostgreSQL and Redis concurrently and reports each dependency independently. The route is public; 503 signals a degraded state while the process stays alive. Use GET /health/live for a dependency-independent liveness probe.',
    responses: {
      200: jsonResponse('Service is ready', healthResponseSchema, {
        status: 'ok',
        db: 'ok',
        redis: 'ok',
      }),
      503: jsonResponse('At least one dependency is unreachable', healthResponseSchema, {
        status: 'degraded',
        db: 'ok',
        redis: 'unavailable',
      }),
      500: jsonResponse('Unexpected server error', errorResponseSchema),
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/health/live',
    operationId: 'getHealthLive',
    tags: ['Health'],
    summary: 'Check process liveness',
    description:
      'Returns quickly without touching PostgreSQL or Redis. A 200 means the API process is up and serving requests; use GET /health for dependency readiness.',
    responses: {
      200: jsonResponse('Process is live', liveResponseSchema, {
        status: 'ok',
      }),
      500: jsonResponse('Unexpected server error', errorResponseSchema),
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/users',
    operationId: 'createUser',
    tags: ['Users'],
    summary: 'Create a user and API key',
    description:
      'Creates a public account. The returned API key is shown only once and is required for every resource endpoint.',
    request: {
      body: jsonBody('Account registration details', createUserBodySchema, {
        username: 'acme-payments',
      }),
    },
    responses: {
      201: jsonResponse('User created', userRegistrationResponseSchema, {
        id: '0f0a7e34-3e48-4f2d-8a18-7dbecf2d532a',
        username: 'acme-payments',
        apiKey: '8f14e45fceea167a5a36dedd4bea2543c1f7a8b9d0e1f2a3b4c5d6e7f8a9b0c1',
      }),
      ...standardErrors({
        badRequest: true,
        conflict: 'Username is already registered',
        payloadTooLarge: true,
      }),
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/endpoints',
    operationId: 'createEndpoint',
    tags: ['Endpoints'],
    summary: 'Register a webhook endpoint',
    description:
      'Validates the destination URL against SSRF policy, stores the endpoint, and returns its HMAC signing secret. The signing secret is only returned by this operation.',
    security: apiKeySecurity,
    request: {
      body: jsonBody('Webhook endpoint registration', createEndpointBodySchema, {
        url: 'https://example.com/webhooks/payments',
        events: ['payment.succeeded', 'invoice.paid'],
      }),
    },
    responses: {
      201: jsonResponse('Endpoint created', createdEndpointResponseSchema, {
        id: '8d8f5d63-0c67-4f49-9b45-a2f63751a6f8',
        url: 'https://example.com/webhooks/payments',
        status: 'ACTIVE',
        events: ['payment.succeeded', 'invoice.paid'],
        createdOn: '2026-10-20T12:00:00.000Z',
        updatedOn: '2026-10-20T12:00:00.000Z',
        signingSecret: 'whsec_1f2e3d4c5b6a79880716253443526170',
      }),
      ...standardErrors({ badRequest: true, unauthorized: true, payloadTooLarge: true }),
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/endpoints',
    operationId: 'listEndpoints',
    tags: ['Endpoints'],
    summary: 'List webhook endpoints',
    description: 'Returns all endpoints owned by the authenticated user.',
    security: apiKeySecurity,
    responses: {
      200: jsonResponse('Owned endpoints', z.array(endpointResponseSchema), [
        {
          id: '8d8f5d63-0c67-4f49-9b45-a2f63751a6f8',
          url: 'https://example.com/webhooks/payments',
          status: 'ACTIVE',
          events: ['payment.succeeded', 'invoice.paid'],
          createdOn: '2026-10-20T12:00:00.000Z',
          updatedOn: '2026-10-20T12:00:00.000Z',
        },
      ]),
      ...standardErrors({ unauthorized: true }),
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/endpoints/{id}',
    operationId: 'getEndpoint',
    tags: ['Endpoints'],
    summary: 'Get a webhook endpoint',
    description:
      'Returns an endpoint owned by the authenticated user. Missing and foreign-owned endpoints both return 404.',
    security: apiKeySecurity,
    request: { params: resourceIdParams },
    responses: {
      200: jsonResponse('Endpoint detail', endpointResponseSchema),
      ...standardErrors({ unauthorized: true, notFound: true }),
    },
  })

  registry.registerPath({
    method: 'patch',
    path: '/endpoints/{id}',
    operationId: 'updateEndpoint',
    tags: ['Endpoints'],
    summary: 'Update a webhook endpoint',
    description:
      'Updates the destination URL and/or active status. A new URL is validated against SSRF policy before it is stored.',
    security: apiKeySecurity,
    request: {
      params: resourceIdParams,
      body: jsonBody('Fields to update', updateEndpointBodySchema, {
        status: 'INACTIVE',
      }),
    },
    responses: {
      200: jsonResponse('Updated endpoint', endpointResponseSchema),
      ...standardErrors({
        badRequest: true,
        unauthorized: true,
        notFound: true,
        payloadTooLarge: true,
      }),
    },
  })

  registry.registerPath({
    method: 'delete',
    path: '/endpoints/{id}',
    operationId: 'deleteEndpoint',
    tags: ['Endpoints'],
    summary: 'Delete a webhook endpoint',
    description:
      'Deletes an endpoint owned by the authenticated user. Its subscriptions and deliveries are removed with it.',
    security: apiKeySecurity,
    request: { params: resourceIdParams },
    responses: {
      204: noContent('Endpoint deleted'),
      ...standardErrors({ unauthorized: true, notFound: true }),
    },
  })

  registry.registerPath({
    method: 'put',
    path: '/endpoints/{id}/subscriptions',
    operationId: 'replaceEndpointSubscriptions',
    tags: ['Endpoints'],
    summary: 'Replace endpoint subscriptions',
    description:
      'Replaces the complete list of event types delivered to an endpoint. Duplicate event types are collapsed.',
    security: apiKeySecurity,
    request: {
      params: resourceIdParams,
      body: jsonBody('Replacement subscription list', updateSubscriptionsBodySchema, {
        events: ['payment.created', 'payment.succeeded'],
      }),
    },
    responses: {
      200: jsonResponse('Endpoint with updated subscriptions', endpointResponseSchema),
      ...standardErrors({
        badRequest: true,
        unauthorized: true,
        notFound: true,
        payloadTooLarge: true,
      }),
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/events',
    operationId: 'createEvent',
    tags: ['Events'],
    summary: 'Ingest an event',
    description:
      'Stores an event and creates one delivery per active subscribed endpoint. The idempotency key is unique per authenticated user. A matching replay returns 200 with X-Idempotency-Replay: true; reusing the key with different content returns 409. The canonical payload must fit MAX_EVENT_PAYLOAD_BYTES independently of the whole-request limit.',
    security: apiKeySecurity,
    request: {
      body: jsonBody('Event to deliver', createEventBodySchema, {
        idempotencyKey: 'payment-succeeded-pay_123',
        eventType: 'payment.succeeded',
        payload: {
          paymentId: 'pay_123',
          amount: 2500,
          currency: 'USD',
        },
      }),
    },
    responses: {
      202: jsonResponse(
        'Event accepted and deliveries queued',
        eventCreatedResponseSchema,
        {
          id: '0b0979a5-06f4-4ce5-bda1-6f63f400bcef',
          eventType: 'payment.succeeded',
          idempotencyKey: 'payment-succeeded-pay_123',
          createdOn: '2026-10-20T12:00:00.000Z',
          deliveries: [
            {
              id: '2b6cf870-15d1-44fd-94a2-29a0c6f3a73d',
              endpointId: '8d8f5d63-0c67-4f49-9b45-a2f63751a6f8',
              status: 'PENDING',
            },
          ],
          replayed: false,
        },
      ),
      200: {
        ...jsonResponse(
          'Identical event already exists; response is an idempotent replay',
          eventCreatedResponseSchema,
          {
            id: '0b0979a5-06f4-4ce5-bda1-6f63f400bcef',
            eventType: 'payment.succeeded',
            idempotencyKey: 'payment-succeeded-pay_123',
            createdOn: '2026-10-20T12:00:00.000Z',
            deliveries: [
              {
                id: '2b6cf870-15d1-44fd-94a2-29a0c6f3a73d',
                endpointId: '8d8f5d63-0c67-4f49-9b45-a2f63751a6f8',
                status: 'PENDING',
              },
            ],
            replayed: true,
          },
        ),
        headers: {
          'X-Idempotency-Replay': {
            description: 'Present and set to true when the request is an idempotent replay',
            schema: { type: 'string', enum: ['true'] },
          },
        },
      },
      ...standardErrors({
        badRequest: true,
        unauthorized: true,
        conflict: 'Idempotency key was reused with a different event type or payload',
        payloadTooLarge: true,
      }),
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/events/{id}',
    operationId: 'getEvent',
    tags: ['Events'],
    summary: 'Inspect an event',
    description:
      'Returns the stored event payload and the state of each delivery. Foreign-owned events return 404.',
    security: apiKeySecurity,
    request: { params: resourceIdParams },
    responses: {
      200: jsonResponse('Event detail', eventDetailResponseSchema),
      ...standardErrors({ unauthorized: true, notFound: true }),
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/events/{id}/deliveries',
    operationId: 'listEventDeliveries',
    tags: ['Events'],
    summary: 'List an event’s deliveries',
    description:
      'Returns delivery state and latest sanitized outcome for every endpoint targeted by the event. Foreign-owned events return 404.',
    security: apiKeySecurity,
    request: { params: resourceIdParams },
    responses: {
      200: jsonResponse('Event deliveries', z.array(deliverySummarySchema)),
      ...standardErrors({ unauthorized: true, notFound: true }),
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/deliveries/{id}',
    operationId: 'getDelivery',
    tags: ['Deliveries'],
    summary: 'Inspect a delivery',
    description:
      'Returns delivery state, retry and replay counters, the latest sanitized response, and its event and endpoint context. Foreign-owned deliveries return 404.',
    security: apiKeySecurity,
    request: { params: resourceIdParams },
    responses: {
      200: jsonResponse('Delivery detail', deliveryDetailResponseSchema),
      ...standardErrors({ unauthorized: true, notFound: true }),
    },
  })

  registry.registerPath({
    method: 'get',
    path: '/deliveries/{id}/attempts',
    operationId: 'listDeliveryAttempts',
    tags: ['Deliveries'],
    summary: 'List delivery attempts',
    description:
      'Returns the attempt history in replay-cycle and attempt order. Old replay cycles are preserved. Foreign-owned deliveries return 404.',
    security: apiKeySecurity,
    request: { params: resourceIdParams },
    responses: {
      200: jsonResponse('Delivery attempts', z.array(deliveryAttemptResponseSchema)),
      ...standardErrors({ unauthorized: true, notFound: true }),
    },
  })

  registry.registerPath({
    method: 'post',
    path: '/deliveries/{id}/replay',
    operationId: 'replayDelivery',
    tags: ['Deliveries'],
    summary: 'Replay a delivery',
    description:
      'Starts a new delivery cycle for a FAILED or SUCCEEDED delivery. Replaying a successful delivery is an intentional redelivery. Active deliveries return 409, and foreign-owned deliveries return 404.',
    security: apiKeySecurity,
    request: { params: resourceIdParams },
    responses: {
      202: jsonResponse('Delivery replay scheduled', deliveryDetailResponseSchema),
      ...standardErrors({
        badRequest: true,
        unauthorized: true,
        notFound: true,
        conflict: 'Delivery is not in a terminal FAILED or SUCCEEDED state',
        payloadTooLarge: true,
      }),
    },
  })

  return new OpenApiGeneratorV3(registry.definitions).generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'Webhook Delivery Service API',
      version: '1.0.0',
      description:
        'Users register webhook endpoints, submit payment events idempotently, and inspect or replay deliveries. Protected operations require the X-API-Key header returned by POST /users. Request bodies are bounded by JSON_BODY_LIMIT_BYTES, while canonical event payloads have a separate MAX_EVENT_PAYLOAD_BYTES limit. The raw OpenAPI document is also available at /openapi.json.',
    },
    servers: [
      {
        url: '/v1',
        description: 'Current server',
      },
    ],
    tags: [
      { name: 'Health', description: 'Liveness checks' },
      { name: 'Users', description: 'Account registration and API keys' },
      { name: 'Endpoints', description: 'Webhook destination management' },
      { name: 'Events', description: 'Event ingestion and inspection' },
      { name: 'Deliveries', description: 'Delivery inspection and replay' },
    ],
  })
}

let cachedDocument: ReturnType<typeof buildDocument> | undefined

/** Returns the generated OpenAPI document, building it once per process. */
export function getOpenApiDocument(): ReturnType<typeof buildDocument> {
  cachedDocument ??= buildDocument()
  return cachedDocument
}
