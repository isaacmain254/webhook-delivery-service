import prisma from '../db.js'
import config from '../config.js'
import type { Prisma } from '../generated/prisma/client.js'
import type { DeliveryStatus } from '../generated/prisma/enums.js'
import type { EventType } from '../lib/events.js'
import { PayloadTooLargeError } from '../lib/errors.js'
import { canonicalizeJson, fingerprintPayload } from '../lib/fingerprint.js'
import { isUniqueConstraintError } from '../lib/prisma-errors.js'

export interface CreateEventInput {
  idempotencyKey: string
  eventType: EventType
  payload: Record<string, unknown>
}

export interface EventDeliverySummary {
  id: string
  endpointId: string
  status: DeliveryStatus
}

export interface EventDetail {
  id: string
  eventType: string
  idempotencyKey: string
  createdOn: Date
  deliveries: EventDeliverySummary[]
}

export type IngestEventOutcome =
  | { outcome: 'created'; event: EventDetail }
  | { outcome: 'replayed'; event: EventDetail }
  | { outcome: 'conflict' }

interface EventLookupRow {
  id: string
  event: string
  idempotencyKey: string
  payload: unknown
  createdOn: Date
  deliveries: EventDeliverySummary[]
}

const deliverySummarySelect = {
  id: true,
  endpointId: true,
  status: true,
} as const

function findEventByKey(userId: string, idempotencyKey: string) {
  return prisma.event.findUnique({
    where: { userId_idempotencyKey: { userId, idempotencyKey } },
    select: {
      id: true,
      event: true,
      idempotencyKey: true,
      payload: true,
      createdOn: true,
      deliveries: { select: deliverySummarySelect },
    },
  })
}

function toEventDetail(row: Omit<EventLookupRow, 'payload'>): EventDetail {
  return {
    id: row.id,
    eventType: row.event,
    idempotencyKey: row.idempotencyKey,
    createdOn: row.createdOn,
    deliveries: row.deliveries,
  }
}

/**
 * An existing event with the same idempotency key is a replay only when its
 * content matches. Comparison uses the same canonical fingerprint as new
 * events, so object-key order does not matter while a different event type or
 * payload is treated as key reuse and reported as a conflict.
 */
function replayOrConflict(row: EventLookupRow, fingerprint: string): IngestEventOutcome {
  let storedFingerprint: string
  try {
    storedFingerprint = fingerprintPayload({ eventType: row.event, payload: row.payload })
  } catch {
    return { outcome: 'conflict' }
  }

  if (storedFingerprint !== fingerprint) {
    return { outcome: 'conflict' }
  }

  return { outcome: 'replayed', event: toEventDetail(row) }
}

/**
 * Ingests an event idempotently and fans it out to the user's active
 * endpoints that subscribe to the event type.
 *
 * The event, its deliveries, and their outbox records are committed in a
 * single transaction. A concurrent duplicate (same user and idempotency key)
 * is detected by the database unique constraint and resolved by comparing the
 * winner's payload fingerprint.
 */
export async function ingestEvent(
  userId: string,
  input: CreateEventInput,
): Promise<IngestEventOutcome> {
  const canonical = canonicalizeJson(input.payload)
  const byteLength = Buffer.byteLength(canonical, 'utf8')
  if (byteLength > config.MAX_EVENT_PAYLOAD_BYTES) {
    throw new PayloadTooLargeError(
      `Event payload exceeds the configured ${config.MAX_EVENT_PAYLOAD_BYTES} byte limit`,
      [
        {
          path: 'body.payload',
          message: `Event payload is ${byteLength} bytes; maximum is ${config.MAX_EVENT_PAYLOAD_BYTES}`,
        },
      ],
    )
  }

  const fingerprint = fingerprintPayload({ eventType: input.eventType, payload: input.payload })

  const existing = await findEventByKey(userId, input.idempotencyKey)
  if (existing) {
    return replayOrConflict(existing, fingerprint)
  }

  try {
    const event = await prisma.$transaction(async (tx) => {
      const created = await tx.event.create({
        data: {
          userId,
          idempotencyKey: input.idempotencyKey,
          event: input.eventType,
          payload: input.payload as Prisma.InputJsonValue,
        },
        select: { id: true, createdOn: true },
      })

      const endpoints = await tx.webhookEndpoint.findMany({
        where: {
          owner: userId,
          status: 'ACTIVE',
          subscriptions: { some: { event: { has: input.eventType } } },
        },
        select: { id: true },
        orderBy: { createdOn: 'asc' },
      })

      let deliveries: EventDeliverySummary[] = []
      if (endpoints.length > 0) {
        // `nextAttempt` is set to creation time so the worker convention is
        // simply "eligible when nextAttempt <= now".
        const now = new Date()
        deliveries = await tx.delivery.createManyAndReturn({
          data: endpoints.map((endpoint) => ({
            userId,
            eventId: created.id,
            endpointId: endpoint.id,
            status: 'PENDING',
            retryCount: 0,
            nextAttempt: now,
          })),
          select: deliverySummarySelect,
        })

        await tx.outboxRecord.createMany({
          data: deliveries.map((delivery) => ({ deliveryId: delivery.id })),
        })
      }

      const detail: EventDetail = {
        id: created.id,
        eventType: input.eventType,
        idempotencyKey: input.idempotencyKey,
        createdOn: created.createdOn,
        deliveries,
      }
      return detail
    })

    return { outcome: 'created', event }
  } catch (error) {
    // A concurrent submission won the insert race. Once its transaction
    // commits, the unique constraint fails ours; resolve against the winner.
    if (isUniqueConstraintError(error)) {
      const winner = await findEventByKey(userId, input.idempotencyKey)
      if (winner) {
        return replayOrConflict(winner, fingerprint)
      }
    }
    throw error
  }
}
