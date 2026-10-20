/** Additive jitter applied to the capped exponential retry delay. */
export const RETRY_JITTER_RATIO = 0.2

export interface RetryDelayOptions {
  /** The 1-based HTTP attempt that just failed. */
  attemptNumber: number
  initialDelayMs: number
  maxDelayMs: number
  /** Raw Retry-After response header, if the receiver supplied one. */
  retryAfter?: string | null
  /** Clock used to resolve an HTTP-date Retry-After value. */
  now?: Date
  /** Injectable randomness for deterministic tests. */
  random?: () => number
  jitterRatio?: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Parses a Retry-After header into milliseconds. Both delta-seconds and
 * HTTP-date forms are supported. Malformed values are ignored. A past date is
 * treated as zero, allowing the normal application backoff to apply.
 */
export function parseRetryAfterMs(
  value: string | null | undefined,
  now: Date = new Date(),
): number | null {
  if (value === null || value === undefined) {
    return null
  }

  const header = value.trim()
  if (header.length === 0) {
    return null
  }

  if (/^\d+$/.test(header)) {
    const seconds = Number(header)
    if (Number.isNaN(seconds)) {
      return null
    }
    if (!Number.isFinite(seconds)) {
      return Number.MAX_SAFE_INTEGER
    }
    return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(seconds * 1_000))
  }

  if (!header.includes(':')) {
    return null
  }

  const dateMs = Date.parse(header)
  if (!Number.isFinite(dateMs)) {
    return null
  }

  return Math.max(0, dateMs - now.getTime())
}

/**
 * Exponential backoff with bounded additive jitter.
 *
 * The failed attempt number is 1-based. The first retry (after attempt 1) uses
 * the initial delay, the second uses twice that, and so on. `Retry-After`, when
 * present and valid, can only lengthen the delay and is capped by the same
 * maximum. The returned delay never exceeds `maxDelayMs`.
 */
export function computeRetryDelayMs(options: RetryDelayOptions): number {
  const attemptNumber = Math.max(1, Math.trunc(options.attemptNumber))
  const initialDelayMs = Math.max(0, Math.trunc(options.initialDelayMs))
  const maxDelayMs = Math.max(0, Math.trunc(options.maxDelayMs))
  const jitterRatio = clamp(options.jitterRatio ?? RETRY_JITTER_RATIO, 0, 1)
  const random = clamp(options.random?.() ?? Math.random(), 0, 1)

  // Multiply with an explicit cap so a corrupt attempt count cannot overflow.
  let baseDelayMs = Math.min(initialDelayMs, maxDelayMs)
  if (baseDelayMs > 0) {
    for (
      let exponent = 1;
      exponent < attemptNumber && baseDelayMs < maxDelayMs;
      exponent += 1
    ) {
      baseDelayMs = Math.min(maxDelayMs, baseDelayMs * 2)
    }
  }

  const jitterMs = Math.floor(baseDelayMs * jitterRatio * random)
  const backoffMs = Math.min(maxDelayMs, baseDelayMs + jitterMs)
  const retryAfterMs = parseRetryAfterMs(
    options.retryAfter,
    options.now ?? new Date(),
  )

  if (retryAfterMs === null) {
    return backoffMs
  }

  return Math.min(maxDelayMs, Math.max(backoffMs, retryAfterMs))
}

/** True while another application-level HTTP attempt is permitted. */
export function isRetryAllowed(
  attemptNumber: number,
  maxDeliveryAttempts: number,
): boolean {
  return attemptNumber < maxDeliveryAttempts
}
