import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import prisma from '../db.js'
import config from '../config.js'
import {
  DeliveryTransportError,
  createHttpDeliveryTransport,
  type DeliveryTransport,
  type WebhookHttpResponse,
} from '../lib/delivery-http.js'
import { signWebhook } from '../lib/hmac.js'
import { SsrfError } from '../lib/ssrf.js'
import {
  buildErrorSummary,
  buildResponseSummary,
  buildWebhookBody,
  classifyHttpStatus,
  type DeliveryAttemptOutcome,
  type DeliveryErrorCode,
} from '../lib/webhook-payload.js'
import type { Prisma } from '../generated/prisma/client.js'

const DEFAULT_WORKER_ID = `${hostname()}:${process.pid}:${randomUUID()}`
const defaultTransport = createHttpDeliveryTransport()

export type DeliveryProcessOutcome = 'succeeded' | 'retrying' | 'failed' | 'skipped'

export interface DeliveryProcessResult {
  deliveryId: string
  outcome: DeliveryProcessOutcome
  attemptCount?: number
}

export interface ProcessDeliveryOptions {
  workerId?: string
  transport?: DeliveryTransport
}

interface ClaimedDelivery {
  deliveryId: string
  attemptNumber: number
}

interface DeliveryOutcomeInput {
  attemptId: number
  attemptNumber: number
  outcome: DeliveryAttemptOutcome
  statusCode: number | null
  responseSummary: string
  durationMs: number
}

/**
 * Atomically claims one delivery. A separate SELECT followed by an UPDATE would
 * let concurrent workers both observe an eligible row, so the status, retry
 * timing, and lease checks are all part of this single statement.
 */
export async function claimDelivery(
  deliveryId: string,
  workerId: string,
  leaseDurationMs: number,
): Promise<ClaimedDelivery | null> {
  const rows = await prisma.$queryRaw<ClaimedDelivery[]>`
    UPDATE "Delivery"
    SET "status" = 'PROCESSING'::"DeliveryStatus",
        "lockedBy" = ${workerId},
        "lockedUntil" = now() + (${leaseDurationMs}::int * interval '1 millisecond')
    WHERE "id" = ${deliveryId}
      AND "status" IN ('PENDING'::"DeliveryStatus", 'RETRYING'::"DeliveryStatus")
      AND ("nextAttempt" IS NULL OR "nextAttempt" <= now())
      AND ("lockedUntil" IS NULL OR "lockedUntil" <= now())
    RETURNING "id" AS "deliveryId",
              COALESCE("retryCount", 0) + 1 AS "attemptNumber"
  `

  return rows[0] ?? null
}

async function resetOutboxForRetry(
  tx: Prisma.TransactionClient,
  deliveryId: string,
): Promise<void> {
  const updated = await tx.outboxRecord.updateMany({
    where: { deliveryId },
    data: {
      published: false,
      publishedAt: null,
      generation: { increment: 1 },
      lockedUntil: null,
      lockedBy: null,
    },
  })

  if (updated.count === 0) {
    await tx.outboxRecord.create({ data: { deliveryId } })
  }
}

async function recordOutcome(
  deliveryId: string,
  input: DeliveryOutcomeInput,
): Promise<DeliveryProcessOutcome> {
  const completedAt = new Date()
  const retryLimitReached = input.attemptNumber >= config.MAX_DELIVERY_ATTEMPTS
  const scheduleRetry = input.outcome === 'retryable' && !retryLimitReached
  const status =
    input.outcome === 'succeeded'
      ? 'SUCCEEDED'
      : scheduleRetry
        ? 'RETRYING'
        : 'FAILED'
  const nextAttempt = scheduleRetry
    ? new Date(completedAt.getTime() + config.INITIAL_RETRY_DELAY_MS)
    : null
  const statusCode = input.statusCode === null ? null : String(input.statusCode)
  const duration = String(input.durationMs)

  await prisma.$transaction(async (tx) => {
    await tx.deliveryAttempts.update({
      where: { id: input.attemptId },
      data: {
        completedAt,
        statusCode,
        response: input.responseSummary,
        duration,
      },
    })

    await tx.delivery.update({
      where: { id: deliveryId },
      data: {
        status,
        ...(scheduleRetry ? { retryCount: input.attemptNumber } : {}),
        nextAttempt,
        statusCode,
        response: input.responseSummary,
        duration,
        lockedUntil: null,
        lockedBy: null,
      },
    })

    if (scheduleRetry) {
      await resetOutboxForRetry(tx, deliveryId)
    }
  })

  if (status === 'SUCCEEDED') {
    return 'succeeded'
  }

  return scheduleRetry ? 'retrying' : 'failed'
}

/**
 * Best-effort recovery for an unexpected internal failure after a claim. The
 * delivery becomes eligible again and its outbox row is reset so the normal
 * dispatcher can schedule it. HTTP/network failures never take this path.
 */
async function releaseFailedClaim(deliveryId: string, workerId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const released = await tx.delivery.updateMany({
      where: { id: deliveryId, lockedBy: workerId, status: 'PROCESSING' },
      data: {
        status: 'RETRYING',
        nextAttempt: new Date(),
        lockedUntil: null,
        lockedBy: null,
      },
    })

    if (released.count === 1) {
      await resetOutboxForRetry(tx, deliveryId)
    }
  })
}

/**
 * Processes one BullMQ delivery job. The outbound request is intentionally
 * performed outside any database transaction, and all response persistence
 * happens after the request settles.
 */
export async function processDeliveryJob(
  deliveryId: string,
  options: ProcessDeliveryOptions = {},
): Promise<DeliveryProcessResult> {
  const workerId = options.workerId ?? DEFAULT_WORKER_ID
  const transport = options.transport ?? defaultTransport

  const claim = await claimDelivery(deliveryId, workerId, config.LEASE_DURATION_MS)
  if (!claim) {
    return { deliveryId, outcome: 'skipped' }
  }

  try {
    const delivery = await prisma.delivery.findUnique({
      where: { id: deliveryId },
      include: {
        event: true,
        endpoint: {
          select: { id: true, url: true, signingSecret: true },
        },
      },
    })

    if (!delivery) {
      await releaseFailedClaim(deliveryId, workerId)
      return { deliveryId, outcome: 'skipped' }
    }

    const startedAt = new Date()
    const attempt = await prisma.deliveryAttempts.create({
      data: {
        deliveryId,
        attemptCount: claim.attemptNumber,
        startedAt,
        duration: '0',
      },
    })

    const body = buildWebhookBody(delivery.event)
    const timestamp = Math.floor(startedAt.getTime() / 1000).toString()
    const signature = signWebhook(
      delivery.endpoint.signingSecret,
      timestamp,
      body,
    )
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body, 'utf8')),
      'user-agent': 'webhook-delivery-service/1.0',
      'x-webhook-event-id': delivery.event.id,
      'x-webhook-event-type': delivery.event.event,
      'x-webhook-delivery-id': delivery.id,
      'x-webhook-timestamp': timestamp,
      'x-webhook-signature': signature,
    }

    let response: WebhookHttpResponse | undefined
    let failureCode: DeliveryErrorCode | undefined

    try {
      response = await transport.send({
        url: delivery.endpoint.url,
        headers,
        body: Buffer.from(body, 'utf8'),
        timeoutMs: config.DELIVERY_TIMEOUT_MS,
      })
    } catch (error) {
      if (error instanceof DeliveryTransportError) {
        failureCode = error.code
      } else if (error instanceof SsrfError) {
        failureCode = 'DESTINATION_REJECTED'
      } else {
        throw error
      }
    }

    const completedAt = new Date()
    const durationMs = Math.max(0, completedAt.getTime() - startedAt.getTime())
    const outcome = failureCode
      ? failureCode === 'DESTINATION_REJECTED'
        ? 'permanent'
        : 'retryable'
      : classifyHttpStatus(response?.statusCode ?? 0)
    const responseSummary = failureCode
      ? buildErrorSummary(failureCode)
      : buildResponseSummary(response?.body ?? '', response?.truncated ?? false)

    const processOutcome = await recordOutcome(deliveryId, {
      attemptId: attempt.id,
      attemptNumber: claim.attemptNumber,
      outcome,
      statusCode: response?.statusCode ?? null,
      responseSummary,
      durationMs,
    })

    return {
      deliveryId,
      outcome: processOutcome,
      attemptCount: claim.attemptNumber,
    }
  } catch (error) {
    await releaseFailedClaim(deliveryId, workerId).catch((releaseError: unknown) => {
      console.error('[delivery] Failed to release claim after internal error', {
        deliveryId,
        error: releaseError,
      })
    })
    throw error
  }
}
