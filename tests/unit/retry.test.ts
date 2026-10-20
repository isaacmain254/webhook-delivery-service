import { describe, expect, it } from 'vitest'
import {
  RETRY_JITTER_RATIO,
  computeRetryDelayMs,
  isRetryAllowed,
  parseRetryAfterMs,
} from '../../src/lib/retry.js'

const now = new Date('2026-10-20T12:00:00.000Z')

function delay(
  attemptNumber: number,
  overrides: Partial<Parameters<typeof computeRetryDelayMs>[0]> = {},
): number {
  return computeRetryDelayMs({
    attemptNumber,
    initialDelayMs: 1_000,
    maxDelayMs: 60_000,
    now,
    random: () => 0,
    ...overrides,
  })
}

describe('computeRetryDelayMs', () => {
  it('uses the initial delay for the first retry and doubles it afterwards', () => {
    expect(delay(1)).toBe(1_000)
    expect(delay(2)).toBe(2_000)
    expect(delay(3)).toBe(4_000)
    expect(delay(4)).toBe(8_000)
  })

  it('adds bounded additive jitter', () => {
    expect(delay(1, { random: () => 1 })).toBe(1_200)
    expect(delay(2, { random: () => 0.5 })).toBe(2_200)
    expect(RETRY_JITTER_RATIO).toBe(0.2)
  })

  it('never exceeds the maximum delay', () => {
    expect(delay(10, { maxDelayMs: 5_000 })).toBe(5_000)
    expect(delay(2, { maxDelayMs: 1_500 })).toBe(1_500)
  })

  it('treats the first retry as exponent zero', () => {
    expect(delay(1, { initialDelayMs: 250, maxDelayMs: 10_000 })).toBe(250)
  })

  it('respects a valid numeric Retry-After header when it is longer', () => {
    expect(delay(1, { retryAfter: '3' })).toBe(3_000)
    expect(delay(1, { retryAfter: '0' })).toBe(1_000)
  })

  it('respects a valid HTTP-date Retry-After header', () => {
    const retryAt = new Date(now.getTime() + 12_000).toUTCString()
    expect(delay(1, { retryAfter: retryAt })).toBe(12_000)
  })

  it('bounds Retry-After by the maximum delay', () => {
    expect(delay(1, { retryAfter: '3600', maxDelayMs: 5_000 })).toBe(5_000)
    expect(delay(1, { retryAfter: '9'.repeat(100), maxDelayMs: 5_000 })).toBe(5_000)
  })

  it('ignores malformed, empty, and past Retry-After values', () => {
    expect(delay(2, { retryAfter: 'not-a-date' })).toBe(2_000)
    expect(delay(2, { retryAfter: '' })).toBe(2_000)
    expect(delay(2, { retryAfter: null })).toBe(2_000)
    expect(
      delay(2, { retryAfter: new Date(now.getTime() - 10_000).toUTCString() }),
    ).toBe(2_000)
  })

  it('clamps invalid attempt numbers and jitter inputs safely', () => {
    expect(delay(0)).toBe(1_000)
    expect(delay(-4)).toBe(1_000)
    expect(delay(1, { random: () => 2 })).toBe(1_200)
    expect(delay(1, { random: () => -1 })).toBe(1_000)
    expect(delay(1, { jitterRatio: 2, random: () => 1 })).toBe(2_000)
  })
})

describe('parseRetryAfterMs', () => {
  it('parses delta seconds', () => {
    expect(parseRetryAfterMs('2', now)).toBe(2_000)
  })

  it('parses HTTP dates relative to the supplied clock', () => {
    const retryAt = new Date(now.getTime() + 45_000).toUTCString()
    expect(parseRetryAfterMs(retryAt, now)).toBe(45_000)
  })

  it('rejects malformed values and bounds unsafe numeric values', () => {
    expect(parseRetryAfterMs('1.5', now)).toBeNull()
    expect(parseRetryAfterMs('soon', now)).toBeNull()
    expect(parseRetryAfterMs('9'.repeat(100), now)).toBe(Number.MAX_SAFE_INTEGER)
    expect(parseRetryAfterMs(undefined, now)).toBeNull()
  })
})

describe('isRetryAllowed', () => {
  it('allows attempts below the total attempt limit only', () => {
    expect(isRetryAllowed(1, 5)).toBe(true)
    expect(isRetryAllowed(4, 5)).toBe(true)
    expect(isRetryAllowed(5, 5)).toBe(false)
    expect(isRetryAllowed(6, 5)).toBe(false)
  })
})
