import { createHmac, timingSafeEqual } from 'node:crypto'

const SIGNATURE_PREFIX = 'sha256='
const HEX_DIGEST = /^[0-9a-f]{64}$/

export interface VerifyWebhookSignatureInput {
  secret: string
  timestamp: string
  body: string | Buffer
  signature: string
}

/**
 * Signs the exact timestamp and body bytes using HMAC-SHA256.
 *
 * The timestamp is a Unix timestamp in seconds. Receivers should verify this
 * signature and then apply their own timestamp-freshness policy.
 */
export function signWebhook(
  secret: string,
  timestamp: string,
  body: string | Buffer,
): string {
  const digest = createHmac('sha256', secret)
    .update(timestamp)
    .update('.')
    .update(body)
    .digest('hex')

  return `${SIGNATURE_PREFIX}${digest}`
}

/**
 * Verifies a `sha256=<hex>` signature in constant time. Malformed signatures,
 * including unknown algorithms, wrong digest lengths, and non-hex input, are
 * rejected without throwing.
 */
export function verifyWebhookSignature(input: VerifyWebhookSignatureInput): boolean {
  try {
    if (!input.signature.startsWith(SIGNATURE_PREFIX)) {
      return false
    }

    const providedHex = input.signature.slice(SIGNATURE_PREFIX.length)
    if (!HEX_DIGEST.test(providedHex)) {
      return false
    }

    const expected = createHmac('sha256', input.secret)
      .update(input.timestamp)
      .update('.')
      .update(input.body)
      .digest()
    const provided = Buffer.from(providedHex, 'hex')

    return provided.length === expected.length && timingSafeEqual(expected, provided)
  } catch {
    return false
  }
}
