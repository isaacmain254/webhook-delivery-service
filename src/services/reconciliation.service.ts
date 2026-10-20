import prisma from '../db.js'
import config from '../config.js'
import { deliveryJobId, type DeliveryQueue } from '../lib/delivery-queue.js'

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
 * Restores scheduling for eligible deliveries that have no durable work.
 *
 * A missing outbox row is created. A published outbox row whose BullMQ job has
 * disappeared (Redis data loss, or a job removed before the delivery reached a
 * terminal state) is reset with a new generation. Reconciliation only writes
 * outbox rows; the dispatcher remains the single publisher.
 *
 * Lease recovery for deliveries stuck in PROCESSING is intentionally left to
 * the delivery worker's recovery process.
 */
export async function reconcileScheduling(
  options: ReconciliationOptions,
): Promise<ReconciliationSummary> {
  const batchSize = options.batchSize ?? config.OUTBOX_RECONCILE_BATCH_SIZE
  const now = options.now ?? new Date()

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
        if (summary.created > 0 || summary.rescheduled > 0) {
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
