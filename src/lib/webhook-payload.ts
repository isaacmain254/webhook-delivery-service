import type { Prisma } from '../generated/prisma/client.js'

export interface WebhookEventSource {
  id: string
  event: string
  payload: Prisma.JsonValue
  createdOn: Date
}

export interface WebhookEventEnvelope {
  id: string
  type: string
  createdAt: string
  data: Prisma.JsonValue
}

export type DeliveryAttemptOutcome = 'succeeded' | 'retryable' | 'permanent'

export type DeliveryErrorCode =
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'DESTINATION_REJECTED'

/**
 * The event envelope is serialized once and those exact bytes are signed and
 * sent, so receivers can verify the signature over the raw request body.
 */
export function buildWebhookBody(event: WebhookEventSource): string {
  const envelope: WebhookEventEnvelope = {
    id: event.id,
    type: event.event,
    createdAt: event.createdOn.toISOString(),
    data: event.payload,
  }

  return JSON.stringify(envelope)
}

export function classifyHttpStatus(statusCode: number): DeliveryAttemptOutcome {
  if (statusCode >= 200 && statusCode < 300) {
    return 'succeeded'
  }

  if (statusCode === 408 || statusCode === 429 || statusCode >= 500) {
    return 'retryable'
  }

  return 'permanent'
}

/** Strips control characters that should not be persisted or displayed. */
export function sanitizeResponseBody(body: string): string {
  return body.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
}

export function buildResponseSummary(body: string, truncated: boolean): string {
  return JSON.stringify({
    body: sanitizeResponseBody(body),
    truncated,
  })
}

export function buildErrorSummary(code: DeliveryErrorCode): string {
  return JSON.stringify({ error: code })
}
