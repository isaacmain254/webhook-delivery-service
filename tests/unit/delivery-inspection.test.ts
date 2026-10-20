import { describe, expect, it } from 'vitest'
import {
  decodeStoredResponse,
  serializeDeliverySummary,
} from '../../src/services/delivery-inspection.service.js'

describe('delivery inspection serialization', () => {
  it('decodes stored response summaries to JSON values', () => {
    expect(decodeStoredResponse('{"body":"ok","truncated":false}')).toEqual({
      body: 'ok',
      truncated: false,
    })
  })

  it('returns null for a missing response and raw text for malformed JSON', () => {
    expect(decodeStoredResponse(null)).toBeNull()
    expect(decodeStoredResponse('not-json')).toBe('not-json')
  })

  it('normalizes delivery fields for the API', () => {
    const response = serializeDeliverySummary({
      id: 'delivery-1',
      eventId: 'event-1',
      endpointId: 'endpoint-1',
      status: 'FAILED',
      retryCount: null,
      replayCount: 2,
      nextAttempt: null,
      statusCode: '503',
      response: '{"body":"unavailable","truncated":false}',
      duration: '42',
      _count: { attempts: 3 },
    })

    expect(response).toEqual({
      id: 'delivery-1',
      eventId: 'event-1',
      endpointId: 'endpoint-1',
      status: 'FAILED',
      retryCount: 0,
      replayCount: 2,
      nextAttempt: null,
      statusCode: 503,
      response: { body: 'unavailable', truncated: false },
      durationMs: 42,
      attemptCount: 3,
    })
  })

  it('maps malformed numeric values to null', () => {
    const response = serializeDeliverySummary({
      id: 'delivery-1',
      eventId: 'event-1',
      endpointId: 'endpoint-1',
      status: 'PENDING',
      retryCount: 0,
      replayCount: 0,
      nextAttempt: null,
      statusCode: 'not-a-code',
      response: null,
      duration: 'not-a-duration',
      _count: { attempts: 0 },
    })

    expect(response.statusCode).toBeNull()
    expect(response.durationMs).toBeNull()
    expect(response.response).toBeNull()
  })
})
