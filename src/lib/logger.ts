import { pino, type Logger } from 'pino'
import config from '../config.js'
import type { AppConfig } from '../config.js'

/**
 * Keys that must never appear in a log line. The denylist is defense in depth
 * behind the primary rule: call sites never log secrets by design. `*` matches
 * one level and `**` matches any depth, so nested context objects are covered
 * without enumerating every caller.
 */
const REDACTION_PATHS = [
  'apiKey',
  'signingSecret',
  'authorization',
  'Authorization',
  'x-api-key',
  'X-API-Key',
  'eventPayload',
  '*.apiKey',
  '*.signingSecret',
  '*.authorization',
  '*.Authorization',
  '*.x-api-key',
  '*.X-API-Key',
  '*.eventPayload',
  '**.apiKey',
  '**.signingSecret',
  '**.authorization',
  '**.Authorization',
  '**.x-api-key',
  '**.X-API-Key',
  '**.eventPayload',
]

/** Converts an unknown thrown value into a plain, JSON-safe object. */
export function serializeError(value: unknown): {
  type?: string
  message?: string
  stack?: string
} {
  if (value instanceof Error) {
    return {
      type: value.name,
      message: value.message,
      stack: value.stack,
    }
  }

  if (typeof value === 'string') {
    return { message: value }
  }

  if (value === null || value === undefined) {
    return {}
  }

  return { message: JSON.stringify(value) }
}

/** Replaces every Error nested inside a value with its serialized form. */
function flattenErrors(value: unknown, depth = 0): unknown {
  if (depth > 6) {
    return value
  }

  if (value instanceof Error) {
    return serializeError(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => flattenErrors(item, depth + 1))
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        flattenErrors(nested, depth + 1),
      ]),
    )
  }

  return value
}

/** Console-compatible facade for shutdown paths typed as `Pick<Console, 'log' | 'warn' | 'error'>`. */
export interface ConsoleLike {
  log(...data: unknown[]): void
  warn(...data: unknown[]): void
  error(...data: unknown[]): void
}

/**
 * Builds pino options from a shared factory so tests can produce identical
 * structured output from an injected destination stream.
 */
export function createLoggerOptions(
  level: AppConfig['LOG_LEVEL'],
): pino.LoggerOptions {
  return {
    level,
    redact: { remove: true, paths: REDACTION_PATHS },
    serializers: {
      // Context objects carry thrown values under `error`; route them through
      // the same serializer so consumers always see `{type, message, stack}`.
      error: (value: unknown) => serializeError(value),
    },
  }
}

export function createLogger(
  level: AppConfig['LOG_LEVEL'],
  destination?: pino.DestinationStream,
): Logger {
  const options = createLoggerOptions(level)
  return destination ? pino(options, destination) : pino(options)
}

export const logger = createLogger(config.LOG_LEVEL)

type PinoHttpRequestLike = {
  method?: string
  url?: string
  id?: string | number
  requestId?: string
}

type PinoHttpResponseLike = {
  statusCode?: number
}

/**
 * Request/response serializers for pino-http. The default request serializer
 * logs every header, which would leak `X-API-Key`; request logs deliberately
 * keep method, url, response code, and the correlation id only.
 */
export const httpLoggerSerializers = {
  req: (req: PinoHttpRequestLike): Record<string, unknown> => ({
    method: req.method,
    url: req.url,
    requestId: req.id ?? req.requestId,
  }),
  res: (res: PinoHttpResponseLike): Record<string, unknown> => ({
    statusCode: res.statusCode,
  }),
}

/**
 * Adapts the pino logger to the existing shutdown signature
 * (`log/warn/error(message, ...context)`), so those call sites keep their
 * current shape instead of being rewritten to the pino object-first form.
 */
export function createConsoleLikeLogger(source: Logger = logger): ConsoleLike {
  function write(level: 'info' | 'warn' | 'error', data: unknown[]): void {
    const [message, ...rest] = data
    const context: Record<string, unknown> = {}
    const extras: unknown[] = []

    for (const item of rest) {
      if (item === null || item === undefined) {
        continue
      }
      if (item instanceof Error) {
        context.error = serializeError(item)
        continue
      }
      if (typeof item === 'object') {
        Object.assign(context, flattenErrors(item) as Record<string, unknown>)
        continue
      }
      extras.push(item)
    }

    if (extras.length > 0) {
      context.extra = extras
    }

    source[level](context, typeof message === 'string' ? message : String(message))
  }

  return {
    log: (...data) => write('info', data),
    warn: (...data) => write('warn', data),
    error: (...data) => write('error', data),
  }
}
