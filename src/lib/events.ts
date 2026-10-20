import { z } from 'zod'

// Fixed catalog of event types for this payment-systems webhook service.
// Subscriptions are validated against this list, and event ingestion will use
// it again in Task 6.
export const EVENT_TYPES = [
  'payment.created',
  'payment.succeeded',
  'payment.failed',
  'payment.canceled',
  'payment.refunded',
  'payment.disputed',
  'invoice.created',
  'invoice.paid',
  'invoice.payment_failed',
  'payout.created',
  'payout.paid',
  'payout.failed',
] as const

export type EventType = (typeof EVENT_TYPES)[number]

export const eventTypeSchema = z.enum(EVENT_TYPES)

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value)
}
