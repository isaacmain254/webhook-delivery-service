import prisma from '../db.js'
import config from '../config.js'
import { deliveryJobId, type DeliveryQueue } from '../lib/delivery-queue.js'
import { buildErrorSummary } from '../lib/webhook-payload.js'
import { resetOutboxForDelivery } from './outbox.service.js'
import type { Prisma } from '../generated/prisma/client.js'

export interface ReconciliationOptions {
  queue: DeliveryQueue
  batchSize?: number
  now?: Date
}

export interface ReconcilerOptions extends ReconciliationOptions {
  intervalMs?: number
}

export interface ReconciliationSummary {
  scanned: number
  created: number
  rescheduled: number
  skipped: number
  recoveredLeases: number
  failedLeases: number
}

interface ExpiredLeaseRow {
  id: string
  retryCount: number | null
  lockedBy: string | null
}

interface LeaseRecoverySummary {
  recovered: number
  failed: number
}

export interface ReconcilerHandle {
  runOnce(): Promise<ReconciliationSummary>
  stop(): Promise<void>
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  )
}

/**
 * Atomically recovers deliveries whose worker lease expired while PROCESSING.
 *
 * The crashed attempt may already have reached the receiver, so recovery
 * consumes one retry from the application budget before scheduling another
 * attempt. If no attempts remain, the delivery becomes FAILED instead of
 * looping forever. Any incomplete attempt records are closed as abandoned.
 */
async function recoverExpiredLeases(
  tx: Prisma.TransactionClient,
  batchSize: number,
  now: Date,
): Promise<LeaseRecoverySummary> {
  const expired = await tx.$queryRaw<ExpiredLeaseRow[]>`
    SELECT "id", "retryCount", "lockedBy"
    FROM "Delivery"
    WHERE "status" = 'PROCESSING'::"DeliveryStatus"
      AND ("lockedUntil" IS NULL OR "lockedUntil" <= ${now})
    ORDER BY "lockedUntil" ASC NULLS FIRST, "id" ASC
    LIMIT ${batchSize}
    FOR UPDATE SKIP LOCKED
  `

  const summary: LeaseRecoverySummary = { recovered: 0, failed: 0 }
  const abandonmentSummary = buildErrorSummary('LEASE_EXPIRED')

  for (const delivery of expired) {
    const attemptNumber = (delivery.retryCount ?? 0) + 1
    const retryAllowed = attemptNumber < config.MAX_DELIVERY_ATTEMPTS
    const where = {
      id: delivery.id,
      status: 'PROCESSING' as const,
      ...(delivery.lockedBy === null ? {} : { lockedBy: delivery.lockedBy }),
      OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }],
    }

    const updated = retryAllowed
      ? await tx.delivery.updateMany({
          where,
          data: {
            status: 'RETRYING',
            retryCount: attemptNumber,
            nextAttempt: now,
            lockedUntil: null,
            lockedBy: null,
          },
        })
      : await tx.delivery.updateMany({
          where,
          data: {
            status: 'FAILED',
            nextAttempt: null,
            lockedUntil: null,
            lockedBy: null,
          },
        })

    if (updated.count === 0) {
      continue
    }

    if (retryAllowed) {
      await resetOutboxForDelivery(tx, delivery.id)
      summary.recovered += 1
    } else {
      summary.failed += 1
    }

    await tx.$executeRaw`
      UPDATE "DeliveryAttempts"
      SET "completedAt" = ${now},
          "response" = ${abandonmentSummary},
          "duration" = GREATEST(
            0,
            ROUND(EXTRACT(EPOCH FROM (${now} - "startedAt")) * 1000)
          )::bigint::text
      WHERE "deliveryId" = ${delivery.id}
        AND "completedAt" IS NULL
    `
  }

  return summary
}

/**
 * Restores scheduling for eligible deliveries that have no durable work.
 *
 * Expired PROCESSING leases are recovered first. Then a missing outbox row is
 * created for an eligible delivery, and a published outbox row whose BullMQ
 * job has disappeared is reset with a new generation. Reconciliation only
 * writes outbox rows; the dispatcher remains the single publisher.
 */
export async function reconcileScheduling(
  options: ReconciliationOptions,
): Promise<ReconciliationSummary> {
  const batchSize = options.batchSize ?? config.OUTBOX_RECONCILE_BATCH_SIZE
  const now = options.now ?? new Date()

  const leaseRecovery = await prisma.$transaction(
    (tx) => recoverExpiredLeases(tx, batchSize, now),
    { timeout: 15_000 },
  )

  const deliveries = await prisma.delivery.findMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      AND: [
        { OR: [{ nextAttempt: null }, { nextAttempt: { lte: now } }] },
        { OR: [{ lockedUntil: null }, { lockedUntil: { lte: now } }] },
      ],
    },
    select: {
      id: true,
      outboxRecords: {
        select: { id: true, published: true, generation: true },
        take: 1,
      },
    },
    orderBy: [{ nextAttempt: 'asc' }, { id: 'asc' }],
    take: batchSize,
  })

  const summary: ReconciliationSummary = {
    scanned: deliveries.length,
    created: 0,
    rescheduled: 0,
    skipped: 0,
    recoveredLeases: leaseRecovery.recovered,
    failedLeases: leaseRecovery.failed,
  }

  for (const delivery of deliveries) {
    const outbox = delivery.outboxRecords[0]

    if (!outbox) {
      try {
        await prisma.outboxRecord.create({ data: { deliveryId: delivery.id } })
        summary.created += 1
      } catch (error) {
        // A concurrent reconciler created it first; its row is equivalent.
        if (isUniqueConstraintError(error)) {
          summary.skipped += 1
        } else {
          throw error
        }
      }
      continue
    }

    if (!outbox.published) {
      // The dispatcher already has a pending record for this delivery.
      summary.skipped += 1
      continue
    }

    const jobId = deliveryJobId(outbox.id, outbox.generation)
    let jobExists: boolean
    try {
      jobExists = await options.queue.hasJob(jobId)
    } catch (error) {
      console.error('[outbox] Reconciliation could not inspect the queue', {
        outboxId: outbox.id,
        jobId,
        error,
      })
      summary.skipped += 1
      continue
    }

    if (jobExists) {
      summary.skipped += 1
      continue
    }

    // The generation check makes this safe against concurrent reconcilers and
    // against a dispatcher that republished the same generation concurrently.
    const reset = await prisma.outboxRecord.updateMany({
      where: { id: outbox.id, published: true, generation: outbox.generation },
      data: {
        published: false,
        publishedAt: null,
        generation: { increment: 1 },
        lockedUntil: null,
        lockedBy: null,
      },
    })

    if (reset.count === 1) {
      summary.rescheduled += 1
    } else {
      summary.skipped += 1
    }
  }

  return summary
}

/** Runs reconciliation on a fixed interval without overlapping runs. */
export function startSchedulingReconciler(options: ReconcilerOptions): ReconcilerHandle {
  const intervalMs = options.intervalMs ?? config.OUTBOX_RECONCILE_INTERVAL_MS
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let active: Promise<void> | null = null

  const scheduleNext = (): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => {
      void tick()
    }, intervalMs)
  }

  const tick = (): Promise<void> => {
    if (stopped || active) {
      return active ?? Promise.resolve()
    }

    active = reconcileScheduling(options)
      .then((summary) => {
        if (
          summary.created > 0 ||
          summary.rescheduled > 0 ||
          summary.recoveredLeases > 0 ||
          summary.failedLeases > 0
        ) {
          console.log('[outbox] Reconciliation run finished', summary)
        }
      })
      .catch((error: unknown) => {
        console.error('[outbox] Reconciliation run failed', error)
      })
      .finally(() => {
        active = null
        scheduleNext()
      })

    return active
  }

  void tick()

  return {
    runOnce: () => reconcileScheduling(options),
    async stop() {
      stopped = true
      if (timer) {
        clearTimeout(timer)
        timer = undefined
      }
      await active
    },
  }
}
