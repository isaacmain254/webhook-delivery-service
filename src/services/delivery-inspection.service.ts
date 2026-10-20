import prisma from '../db.js'
import type { Prisma } from '../generated/prisma/client.js'
import type { DeliveryStatus, EndpointStatus } from '../generated/prisma/enums.js'

export interface DeliverySummaryResponse {
  id: string
  eventId: string
  endpointId: string
  status: DeliveryStatus
  retryCount: number
  replayCount: number
  nextAttempt: Date | null
  statusCode: number | null
  response: unknown
  durationMs: number | null
  attemptCount: number
}

export interface EventInspectionDetail {
  id: string
  eventType: string
  idempotencyKey: string
  payload: Prisma.JsonValue
  createdOn: Date
  deliveries: DeliverySummaryResponse[]
}

export interface DeliveryInspectionDetail extends DeliverySummaryResponse {
  event: {
    id: string
    eventType: string
    createdOn: Date
  }
  endpoint: {
    id: string
    url: string
    status: EndpointStatus
  }
}

export interface DeliveryAttemptResponse {
  id: number
  replayCount: number
  attemptCount: number
  startedAt: Date
  completedAt: Date | null
  statusCode: number | null
  response: unknown
  durationMs: number | null
}

interface DeliverySummaryRow {
  id: string
  eventId: string
  endpointId: string
  status: DeliveryStatus
  retryCount: number | null
  replayCount: number
  nextAttempt: Date | null
  statusCode: string | null
  response: string | null
  duration: string | null
  _count: { attempts: number }
}

interface DeliveryDetailRow extends DeliverySummaryRow {
  event: {
    id: string
    event: string
    createdOn: Date
  }
  endpoint: {
    id: string
    url: string
    status: EndpointStatus
  }
}

interface DeliveryAttemptRow {
  id: number
  replayCount: number
  attemptCount: number
  startedAt: Date
  completedAt: Date | null
  statusCode: string | null
  response: string | null
  duration: string | null
}

export const deliverySummarySelect = {
  id: true,
  eventId: true,
  endpointId: true,
  status: true,
  retryCount: true,
  replayCount: true,
  nextAttempt: true,
  statusCode: true,
  response: true,
  duration: true,
  _count: { select: { attempts: true } },
} as const

export const deliveryDetailSelect = {
  ...deliverySummarySelect,
  event: { select: { id: true, event: true, createdOn: true } },
  endpoint: { select: { id: true, url: true, status: true } },
} as const

/** Decodes a stored sanitized summary without allowing corrupt JSON to throw. */
export function decodeStoredResponse(value: string | null): unknown {
  if (value === null) {
    return null
  }

  try {
    return JSON.parse(value) as unknown
  } catch {
    return value
  }
}

function decodeStatusCode(value: string | null): number | null {
  if (value === null) {
    return null
  }

  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

function decodeDuration(value: string | null): number | null {
  if (value === null) {
    return null
  }

  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : null
}

export function serializeDeliverySummary(
  row: DeliverySummaryRow,
): DeliverySummaryResponse {
  return {
    id: row.id,
    eventId: row.eventId,
    endpointId: row.endpointId,
    status: row.status,
    retryCount: row.retryCount ?? 0,
    replayCount: row.replayCount,
    nextAttempt: row.nextAttempt,
    statusCode: decodeStatusCode(row.statusCode),
    response: decodeStoredResponse(row.response),
    durationMs: decodeDuration(row.duration),
    attemptCount: row._count.attempts,
  }
}

export function serializeDeliveryDetail(
  row: DeliveryDetailRow,
): DeliveryInspectionDetail {
  return {
    ...serializeDeliverySummary(row),
    event: {
      id: row.event.id,
      eventType: row.event.event,
      createdOn: row.event.createdOn,
    },
    endpoint: {
      id: row.endpoint.id,
      url: row.endpoint.url,
      status: row.endpoint.status,
    },
  }
}

function serializeAttempt(row: DeliveryAttemptRow): DeliveryAttemptResponse {
  return {
    id: row.id,
    replayCount: row.replayCount,
    attemptCount: row.attemptCount,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    statusCode: decodeStatusCode(row.statusCode),
    response: decodeStoredResponse(row.response),
    durationMs: decodeDuration(row.duration),
  }
}

export async function getEventDetailForUser(
  userId: string,
  eventId: string,
): Promise<EventInspectionDetail | null> {
  const event = await prisma.event.findFirst({
    where: { id: eventId, userId },
    select: {
      id: true,
      event: true,
      idempotencyKey: true,
      payload: true,
      createdOn: true,
      deliveries: {
        select: deliverySummarySelect,
        orderBy: { endpointId: 'asc' },
      },
    },
  })

  if (!event) {
    return null
  }

  return {
    id: event.id,
    eventType: event.event,
    idempotencyKey: event.idempotencyKey,
    payload: event.payload,
    createdOn: event.createdOn,
    deliveries: event.deliveries.map(serializeDeliverySummary),
  }
}

export async function listEventDeliveriesForUser(
  userId: string,
  eventId: string,
): Promise<DeliverySummaryResponse[] | null> {
  const event = await prisma.event.findFirst({
    where: { id: eventId, userId },
    select: {
      deliveries: {
        select: deliverySummarySelect,
        orderBy: { endpointId: 'asc' },
      },
    },
  })

  return event ? event.deliveries.map(serializeDeliverySummary) : null
}

export async function getDeliveryDetailForUser(
  userId: string,
  deliveryId: string,
): Promise<DeliveryInspectionDetail | null> {
  const delivery = await prisma.delivery.findFirst({
    where: { id: deliveryId, userId },
    select: deliveryDetailSelect,
  })

  return delivery ? serializeDeliveryDetail(delivery) : null
}

export async function listDeliveryAttemptsForUser(
  userId: string,
  deliveryId: string,
): Promise<DeliveryAttemptResponse[] | null> {
  const delivery = await prisma.delivery.findFirst({
    where: { id: deliveryId, userId },
    select: { id: true },
  })

  if (!delivery) {
    return null
  }

  const attempts = await prisma.deliveryAttempts.findMany({
    where: { deliveryId },
    orderBy: [{ replayCount: 'asc' }, { attemptCount: 'asc' }, { id: 'asc' }],
    select: {
      id: true,
      replayCount: true,
      attemptCount: true,
      startedAt: true,
      completedAt: true,
      statusCode: true,
      response: true,
      duration: true,
    },
  })

  return attempts.map(serializeAttempt)
}
