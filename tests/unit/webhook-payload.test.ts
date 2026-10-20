import { describe, expect, it } from 'vitest'
import {
  buildErrorSummary,
  buildResponseSummary,
  buildWebhookBody,
  classifyHttpStatus,
  sanitizeResponseBody,
} from '../../src/lib/webhook-payload.js'

describe('webhook payload helpers', () => {
  it('serializes the documented event envelope', () => {
    const body = buildWebhookBody({
      id: 'event-1',
      event: 'payment.succeeded',
      payload: { amount: 1000, currency: 'usd' },
      createdOn: new Date('2026-10-20T12:00:00.000Z'),
    })

    expect(JSON.parse(body)).toEqual({
      id: 'event-1',
      type: 'payment.succeeded',
      createdAt: '2026-10-20T12:00:00.000Z',
      data: { amount: 1000, currency: 'usd' },
    })
  })

  it.each([
    [200, 'succeeded'],
    [201, 'succeeded'],
    [299, 'succeeded'],
    [408, 'retryable'],
    [429, 'retryable'],
    [500, 'retryable'],
    [503, 'retryable'],
    [301, 'permanent'],
    [400, 'permanent'],
    [404, 'permanent'],
    [422, 'permanent'],
  ] as const)('classifies HTTP %i as %s', (status, expected) => {
    expect(classifyHttpStatus(status)).toBe(expected)
  })

  it('strips control characters but keeps readable whitespace', () => {
    expect(sanitizeResponseBody('a\u0000b\u0007c\td\ne\rf\u007f')).toBe(
      'abc\td\ne\rf',
    )
  })

  it('stores bounded response and error summaries as JSON', () => {
    expect(JSON.parse(buildResponseSummary('ok', false))).toEqual({
      body: 'ok',
      truncated: false,
    })
    expect(JSON.parse(buildResponseSummary('partial', true))).toEqual({
      body: 'partial',
      truncated: true,
    })
    expect(JSON.parse(buildErrorSummary('TIMEOUT'))).toEqual({ error: 'TIMEOUT' })
    expect(JSON.parse(buildErrorSummary('LEASE_EXPIRED'))).toEqual({
      error: 'LEASE_EXPIRED',
    })
  })
})
