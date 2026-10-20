import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { signWebhook, verifyWebhookSignature } from '../../src/lib/hmac.js'

describe('webhook HMAC signing', () => {
  it('signs the timestamp and exact body bytes with sha256', () => {
    const timestamp = '1700000000'
    const body = '{"id":"event-1","type":"payment.succeeded"}'
    const expected = createHmac('sha256', 'signing-secret')
      .update(`${timestamp}.${body}`)
      .digest('hex')

    expect(signWebhook('signing-secret', timestamp, body)).toBe(`sha256=${expected}`)
  })

  it('verifies a valid signature over a Buffer body', () => {
    const timestamp = '1700000000'
    const body = Buffer.from('{"amount":1000}', 'utf8')
    const signature = signWebhook('signing-secret', timestamp, body)

    expect(
      verifyWebhookSignature({
        secret: 'signing-secret',
        timestamp,
        body,
        signature,
      }),
    ).toBe(true)
  })

  it('rejects an altered body, timestamp, or secret', () => {
    const timestamp = '1700000000'
    const body = '{"amount":1000}'
    const signature = signWebhook('signing-secret', timestamp, body)

    expect(
      verifyWebhookSignature({
        secret: 'signing-secret',
        timestamp,
        body: '{"amount":1001}',
        signature,
      }),
    ).toBe(false)

    expect(
      verifyWebhookSignature({
        secret: 'signing-secret',
        timestamp: '1700000001',
        body,
        signature,
      }),
    ).toBe(false)

    expect(
      verifyWebhookSignature({
        secret: 'different-secret',
        timestamp,
        body,
        signature,
      }),
    ).toBe(false)
  })

  it('rejects malformed signatures without throwing', () => {
    const base = {
      secret: 'signing-secret',
      timestamp: '1700000000',
      body: '{}',
    }

    for (const signature of [
      '',
      'sha256=',
      'sha256=not-hex',
      `sha256=${'a'.repeat(63)}`,
      `sha256=${'z'.repeat(64)}`,
      `SHA256=${'a'.repeat(64)}`,
    ]) {
      expect(verifyWebhookSignature({ ...base, signature })).toBe(false)
    }
  })
})
