import supertest from 'supertest'
import { describe, expect, it } from 'vitest'
import { getOpenApiDocument } from '../../src/docs/openapi.js'
import {
  createdEndpointResponseSchema,
  errorResponseSchema,
  eventCreatedResponseSchema,
  healthResponseSchema,
  userRegistrationResponseSchema,
} from '../../src/docs/schemas.js'
import {
  createEndpointBodySchema,
  updateEndpointBodySchema,
  updateSubscriptionsBodySchema,
} from '../../src/schemas/endpoint.schema.js'
import { createEventBodySchema } from '../../src/schemas/event.schema.js'
import { createUserBodySchema } from '../../src/schemas/user.schema.js'
import { createTestApp } from '../helpers/test-app.js'

const app = createTestApp()

type OpenApiDocument = ReturnType<typeof getOpenApiDocument>
type JsonObject = Record<string, any>

const expectedOperations: Record<string, string[]> = {
  '/health': ['get'],
  '/users': ['post'],
  '/endpoints': ['post', 'get'],
  '/endpoints/{id}': ['get', 'patch', 'delete'],
  '/endpoints/{id}/subscriptions': ['put'],
  '/events': ['post'],
  '/events/{id}': ['get'],
  '/events/{id}/deliveries': ['get'],
  '/deliveries/{id}': ['get'],
  '/deliveries/{id}/attempts': ['get'],
  '/deliveries/{id}/replay': ['post'],
}

function operation(document: OpenApiDocument, path: string, method: string): JsonObject {
  return (document.paths[path] as JsonObject)[method] as JsonObject
}

function requestExample(
  document: OpenApiDocument,
  path: string,
  method: string,
): unknown {
  return operation(document, path, method).requestBody.content['application/json'].example
}

function responseExample(
  document: OpenApiDocument,
  path: string,
  method: string,
  status: string,
): unknown {
  return operation(document, path, method).responses[status].content['application/json'].example
}

function collectRefs(value: unknown, refs = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectRefs(item, refs)
    }
    return refs
  }

  if (typeof value === 'object' && value !== null) {
    for (const [key, nested] of Object.entries(value)) {
      if (key === '$ref' && typeof nested === 'string') {
        refs.add(nested)
      } else {
        collectRefs(nested, refs)
      }
    }
  }

  return refs
}

function resolveRef(document: OpenApiDocument, ref: string): unknown {
  const parts = ref.replace(/^#\//, '').split('/')
  let current: any = document
  for (const part of parts) {
    current = current?.[part]
  }
  return current
}

describe('API documentation', () => {
  it('serves the Stoplight docs page without authentication', async () => {
    const response = await supertest(app).get('/docs').expect(200)

    expect(response.headers['content-type']).toContain('text/html')
    expect(response.text).toContain('<elements-api')
    expect(response.text).toContain('apiDescriptionUrl="/openapi.json"')
    expect(response.text).toContain('router="hash"')
    expect(response.text).toContain('layout="sidebar"')
    expect(response.text).toContain('/docs/assets/stoplight-elements.js')
    expect(response.text).toContain('/docs/assets/stoplight-elements.css')
    expect(response.text).not.toContain('unpkg.com')
  })

  it('serves the docs page at both /docs and /docs/', async () => {
    await supertest(app).get('/docs/').expect(200)
  })

  it('serves locally installed Stoplight assets', async () => {
    const script = await supertest(app)
      .head('/docs/assets/stoplight-elements.js')
      .expect(200)
    expect(script.headers['content-type']).toContain('javascript')

    const styles = await supertest(app)
      .head('/docs/assets/stoplight-elements.css')
      .expect(200)
    expect(styles.headers['content-type']).toContain('text/css')
  })

  it('serves the generated OpenAPI document without authentication', async () => {
    const response = await supertest(app)
      .get('/openapi.json')
      .expect('Content-Type', /json/)
      .expect(200)

    const document = response.body as OpenApiDocument
    expect(document.openapi).toBe('3.0.3')
    expect(document.info).toMatchObject({
      title: 'Webhook Delivery Service API',
      version: '1.0.0',
    })
    expect(document.servers).toEqual([
      { url: '/v1', description: 'Current server' },
    ])
    expect(document.components.securitySchemes?.ApiKeyAuth).toMatchObject({
      type: 'apiKey',
      in: 'header',
      name: 'X-API-Key',
    })
  })

  it('documents every API operation', async () => {
    const response = await supertest(app).get('/openapi.json').expect(200)
    const document = response.body as OpenApiDocument

    expect(Object.keys(document.paths).sort()).toEqual(
      Object.keys(expectedOperations).sort(),
    )

    let operationCount = 0
    for (const [path, methods] of Object.entries(expectedOperations)) {
      for (const method of methods) {
        operationCount += 1
        expect(operation(document, path, method)).toMatchObject({
          operationId: expect.any(String),
          summary: expect.any(String),
          tags: expect.any(Array),
          responses: expect.any(Object),
        })
      }
    }

    expect(operationCount).toBe(14)
  })

  it('declares API-key security only on protected operations', () => {
    const document = getOpenApiDocument()

    expect(operation(document, '/health', 'get').security).toBeUndefined()
    expect(operation(document, '/users', 'post').security).toBeUndefined()

    for (const [path, methods] of Object.entries(expectedOperations)) {
      if (path === '/health' || path === '/users') {
        continue
      }

      for (const method of methods) {
        expect(operation(document, path, method).security).toEqual([
          { ApiKeyAuth: [] },
        ])
      }
    }
  })

  it('registers the error and resource response components', () => {
    const document = getOpenApiDocument()
    const schemas = document.components.schemas ?? {}

    expect(Object.keys(schemas)).toEqual(
      expect.arrayContaining([
        'ErrorResponse',
        'HealthResponse',
        'UserRegistrationResponse',
        'Endpoint',
        'CreatedEndpoint',
        'EventType',
        'EventCreatedResponse',
        'EventDetailResponse',
        'DeliverySummary',
        'DeliveryDetailResponse',
        'DeliveryAttempt',
        'CreateUserBody',
        'CreateEndpointBody',
        'UpdateEndpointBody',
        'UpdateSubscriptionsBody',
        'CreateEventBody',
      ]),
    )
  })

  it('resolves every component reference', () => {
    const document = getOpenApiDocument()

    for (const ref of collectRefs(document)) {
      expect(ref).toMatch(/^#\/components\//)
      expect(resolveRef(document, ref)).toBeDefined()
    }
  })

  it('keeps documented request examples valid against the runtime schemas', () => {
    const document = getOpenApiDocument()

    expect(createUserBodySchema.safeParse(requestExample(document, '/users', 'post')).success).toBe(true)
    expect(
      createEndpointBodySchema.safeParse(
        requestExample(document, '/endpoints', 'post'),
      ).success,
    ).toBe(true)
    expect(
      updateEndpointBodySchema.safeParse(
        requestExample(document, '/endpoints/{id}', 'patch'),
      ).success,
    ).toBe(true)
    expect(
      updateSubscriptionsBodySchema.safeParse(
        requestExample(document, '/endpoints/{id}/subscriptions', 'put'),
      ).success,
    ).toBe(true)
    expect(
      createEventBodySchema.safeParse(requestExample(document, '/events', 'post'))
        .success,
    ).toBe(true)
  })

  it('keeps documented response examples valid against the response schemas', () => {
    const document = getOpenApiDocument()

    expect(
      healthResponseSchema.safeParse(responseExample(document, '/health', 'get', '200'))
        .success,
    ).toBe(true)
    expect(
      userRegistrationResponseSchema.safeParse(
        responseExample(document, '/users', 'post', '201'),
      ).success,
    ).toBe(true)
    expect(
      createdEndpointResponseSchema.safeParse(
        responseExample(document, '/endpoints', 'post', '201'),
      ).success,
    ).toBe(true)
    expect(
      eventCreatedResponseSchema.safeParse(
        responseExample(document, '/events', 'post', '202'),
      ).success,
    ).toBe(true)
    expect(
      eventCreatedResponseSchema.safeParse(
        responseExample(document, '/events', 'post', '200'),
      ).success,
    ).toBe(true)
    expect(
      errorResponseSchema.safeParse({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: [],
        },
      }).success,
    ).toBe(true)
  })

  it('documents idempotency headers and the important error statuses', () => {
    const document = getOpenApiDocument()
    const createEvent = operation(document, '/events', 'post')

    expect(createEvent.responses['200'].headers['X-Idempotency-Replay']).toMatchObject({
      schema: { type: 'string', enum: ['true'] },
    })
    expect(createEvent.responses).toHaveProperty('202')
    expect(createEvent.responses).toHaveProperty('409')
    expect(createEvent.responses).toHaveProperty('413')
    expect(createEvent.responses).toHaveProperty('422')
    expect(operation(document, '/deliveries/{id}/replay', 'post').responses).toHaveProperty(
      '409',
    )
    expect(operation(document, '/endpoints/{id}', 'get').responses).toHaveProperty('404')
  })
})
