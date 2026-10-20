import { describe, expect, it } from 'vitest'
import {
  canonicalizeJson,
  fingerprintPayload,
  isJsonCanonicalizable,
} from '../../src/lib/fingerprint.js'

describe('canonicalizeJson', () => {
  it('is independent of object key order', () => {
    expect(canonicalizeJson({ b: 1, a: 2 })).toBe(canonicalizeJson({ a: 2, b: 1 }))
  })

  it('is independent of key order in nested objects', () => {
    const first = { b: { d: 4, c: 3 }, a: [{ y: 2, x: 1 }] }
    const second = { a: [{ x: 1, y: 2 }], b: { c: 3, d: 4 } }

    expect(canonicalizeJson(first)).toBe(canonicalizeJson(second))
  })

  it('preserves array order', () => {
    expect(canonicalizeJson([1, 2, 3])).not.toBe(canonicalizeJson([3, 2, 1]))
  })

  it('distinguishes values of different types', () => {
    expect(canonicalizeJson({ amount: 1 })).not.toBe(canonicalizeJson({ amount: '1' }))
    expect(canonicalizeJson({ value: null })).not.toBe(canonicalizeJson({ value: false }))
  })

  it('keeps unicode characters and escapes intact', () => {
    expect(canonicalizeJson({ emoji: '💳', quote: 'a"b' })).toBe(
      '{"emoji":"💳","quote":"a\\"b"}',
    )
  })

  it('throws for non-finite numbers', () => {
    expect(() => canonicalizeJson({ amount: Number.POSITIVE_INFINITY })).toThrow(
      /non-finite number/,
    )
    expect(() => canonicalizeJson([Number.NaN])).toThrow(/non-finite number/)
  })

  it('throws for undefined values that JSON cannot represent', () => {
    expect(() => canonicalizeJson({ missing: undefined })).toThrow(/undefined value/)
  })
})

describe('fingerprintPayload', () => {
  it('produces a stable SHA-256 hex digest', () => {
    expect(fingerprintPayload({ a: 1 })).toMatch(/^[a-f0-9]{64}$/)
  })

  it('is identical for payloads with different key order', () => {
    expect(fingerprintPayload({ b: 2, a: 1 })).toBe(fingerprintPayload({ a: 1, b: 2 }))
  })

  it('changes when payload content changes', () => {
    expect(fingerprintPayload({ amount: 1000 })).not.toBe(fingerprintPayload({ amount: 2000 }))
  })
})

describe('isJsonCanonicalizable', () => {
  it('accepts nested JSON values', () => {
    expect(isJsonCanonicalizable({ a: [1, 'two', null, { b: true }] })).toBe(true)
    expect(isJsonCanonicalizable({})).toBe(true)
  })

  it('rejects values with non-finite numbers or undefined', () => {
    expect(isJsonCanonicalizable({ a: Number.POSITIVE_INFINITY })).toBe(false)
    expect(isJsonCanonicalizable({ a: undefined })).toBe(false)
  })
})
