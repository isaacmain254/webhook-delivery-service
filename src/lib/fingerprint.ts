import { createHash } from 'node:crypto'

/**
 * Raised when a value cannot be represented as canonical JSON. API payloads
 * come from JSON requests, so this only happens for values that JSON.parse
 * can produce but JSON.stringify cannot round-trip safely (for example `1e400`
 * parses to Infinity).
 */
export class JsonCanonicalizationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'JsonCanonicalizationError'
  }
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JsonCanonicalizationError('Payload contains a non-finite number')
    }
    return value
  }

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(item))
  }

  if (typeof value === 'object') {
    const source = value as Record<string, unknown>
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(source).sort()) {
      const entry = source[key]
      if (entry === undefined) {
        throw new JsonCanonicalizationError('Payload contains an undefined value')
      }
      result[key] = canonicalizeValue(entry)
    }
    return result
  }

  throw new JsonCanonicalizationError(`Payload contains an unsupported ${typeof value} value`)
}

/**
 * Serializes a JSON value deterministically: object keys are sorted, array
 * order is preserved, and primitives keep their JavaScript representation.
 * Two payloads with the same content produce the same string regardless of
 * object-key insertion order, which plain JSON.stringify does not guarantee.
 */
export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value))
}

/** SHA-256 fingerprint of the canonical JSON representation. */
export function fingerprintPayload(value: unknown): string {
  return createHash('sha256').update(canonicalizeJson(value)).digest('hex')
}

/** True when the value can be canonicalized; used by request validation. */
export function isJsonCanonicalizable(value: unknown): boolean {
  try {
    canonicalizeJson(value)
    return true
  } catch {
    return false
  }
}
