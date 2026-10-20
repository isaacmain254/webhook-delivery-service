import { randomUUID } from 'node:crypto'
import prisma from '../db.js'
import config from '../config.js'
import { deliveryJobId, type DeliveryQueue } from '../lib/delivery-queue.js'
import type { Prisma } from '../generated/prisma/client.js'

/** Safety cap so a large backlog cannot keep one polling tick busy forever. */
const MAX_BATCHES_PER_RUN = 10

export interface ClaimedOutboxRecord {
  id: string
  deliveryId: string
  generation: number
  nextAttempt: Date | string | null
}

export interface ClaimOutboxOptions {
  batchSize: number
  leaseDurationMs: number
  claimToken?: string
}

export interface DispatchOptions {
  queue: DeliveryQueue
  batchSize?: number
  leaseDurationMs?: number
}

export interface DispatchBatchOptions extends DispatchOptions {
  claimToken?: string
}

export interface DispatchSummary {
  claimed: number
  published: number
  failed: number
}

export interface OutboxDispatcherOptions extends DispatchOptions {
  pollIntervalMs?: number
  maxBatchesPerRun?: number
}

export interface OutboxDispatcherHandle {
  runOnce(): Promise<DispatchSummary>
  stop(): Promise<void>
}

/**
 * Makes a delivery dispatchable again in the same transaction that changes its
 * delivery state. Bumping the generation gives the new scheduling cycle a new
 * stable BullMQ job ID. Delivery and reconciliation recovery both use this
 * helper so a missing outbox row is recreated consistently.
 */
export async function resetOutboxForDelivery(
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

/**
 * Claims a bounded batch of unpublished outbox rows for this dispatcher.
 *
 * The update and the SELECT ... FOR UPDATE SKIP LOCKED run as one statement, so
 * no transaction is held while publishing to Redis. A claimed row is protected
 * by a lease; a crashed dispatcher's rows become claimable again when it
 * expires.
 */
export async function claimOutboxBatch(
  options: ClaimOutboxOptions,
): Promise<ClaimedOutboxRecord[]> {
  const claimToken = options.claimToken ?? `outbox-${randomUUID()}`

  return prisma.$queryRaw<ClaimedOutboxRecord[]>`
    UPDATE "OutboxRecord" AS outbox
    SET "lockedUntil" = now() + (${options.leaseDurationMs}::int * interval '1 millisecond'),
        "lockedBy" = ${claimToken}
    WHERE outbox."id" IN (
      SELECT "id"
      FROM "OutboxRecord"
      WHERE "published" = false
        AND ("lockedUntil" IS NULL OR "lockedUntil" <= now())
      ORDER BY "createdAt" ASC
      LIMIT ${options.batchSize}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING outbox."id",
              outbox."deliveryId",
              outbox."generation",
              (
                SELECT delivery."nextAttempt"
                FROM "Delivery" AS delivery
                WHERE delivery."id" = outbox."deliveryId"
              ) AS "nextAttempt"
  `
}

async function markOutboxPublished(
  id: string,
  generation: number,
  claimToken: string,
  now: Date,
): Promise<boolean> {
  const result = await prisma.outboxRecord.updateMany({
    where: { id, generation, published: false, lockedBy: claimToken },
    data: { published: true, publishedAt: now, lockedUntil: null, lockedBy: null },
  })

  return result.count === 1
}

async function releaseOutboxClaim(
  id: string,
  generation: number,
  claimToken: string,
): Promise<void> {
  await prisma.outboxRecord.updateMany({
    where: { id, generation, published: false, lockedBy: claimToken },
    data: { lockedUntil: null, lockedBy: null },
  })
}

function publicationDelayMs(record: ClaimedOutboxRecord): number | undefined {
  if (record.nextAttempt === null) {
    return undefined
  }

  const nextAttemptMs =
    record.nextAttempt instanceof Date
      ? record.nextAttempt.getTime()
      : new Date(record.nextAttempt).getTime()

  if (!Number.isFinite(nextAttemptMs)) {
    return undefined
  }

  const delayMs = nextAttemptMs - Date.now()
  return delayMs > 0 ? delayMs : undefined
}

/**
 * Publishes one claimed batch. Any publish failure leaves the row unpublished
 * and releases its lease so the next poll can retry it.
 */
export async function dispatchOutboxBatch(
  options: DispatchBatchOptions,
): Promise<DispatchSummary> {
  const batchSize = options.batchSize ?? config.OUTBOX_BATCH_SIZE
  const leaseDurationMs = options.leaseDurationMs ?? config.OUTBOX_LEASE_DURATION_MS
  const claimToken = options.claimToken ?? `outbox-${randomUUID()}`

  const records = await claimOutboxBatch({ batchSize, leaseDurationMs, claimToken })

  let published = 0
  let failed = 0

  for (const record of records) {
    try {
      const delayMs = publicationDelayMs(record)
      await options.queue.enqueue(
        record.deliveryId,
        deliveryJobId(record.id, record.generation),
        delayMs === undefined ? undefined : { delayMs },
      )

      if (
        await markOutboxPublished(
          record.id,
          record.generation,
          claimToken,
          new Date(),
        )
      ) {
        published += 1
      } else {
        // The lease expired and another dispatcher took over. It publishes the
        // same stable job ID, so BullMQ still has only one logical job.
        console.warn('[outbox] Lost claim before publication could be recorded', {
          outboxId: record.id,
        })
      }
    } catch (error) {
      failed += 1
      await releaseOutboxClaim(record.id, record.generation, claimToken).catch((releaseError) => {
        console.error('[outbox] Failed to release claim', {
          outboxId: record.id,
          error: releaseError,
        })
      })
      console.error('[outbox] Failed to publish delivery job', {
        outboxId: record.id,
        deliveryId: record.deliveryId,
        error,
      })
    }
  }

  return { claimed: records.length, published, failed }
}

/**
 * Drains up to `MAX_BATCHES_PER_RUN` full batches in one tick. Stops early on
 * a partial batch or a publish failure so errors are retried on the next poll
 * rather than in a tight loop.
 */
export async function dispatchPendingOutbox(
  options: OutboxDispatcherOptions,
): Promise<DispatchSummary> {
  const batchSize = options.batchSize ?? config.OUTBOX_BATCH_SIZE
  const leaseDurationMs = options.leaseDurationMs ?? config.OUTBOX_LEASE_DURATION_MS
  const maxBatchesPerRun = options.maxBatchesPerRun ?? MAX_BATCHES_PER_RUN

  const totals: DispatchSummary = { claimed: 0, published: 0, failed: 0 }

  for (let batch = 0; batch < maxBatchesPerRun; batch += 1) {
    const result = await dispatchOutboxBatch({
      queue: options.queue,
      batchSize,
      leaseDurationMs,
    })

    totals.claimed += result.claimed
    totals.published += result.published
    totals.failed += result.failed

    if (result.claimed < batchSize || result.failed > 0) {
      break
    }
  }

  return totals
}

/**
 * Runs the dispatcher on a fixed interval. Ticks never overlap: the next one is
 * scheduled only after the current run settles.
 */
export function startOutboxDispatcher(
  options: OutboxDispatcherOptions,
): OutboxDispatcherHandle {
  const pollIntervalMs = options.pollIntervalMs ?? config.OUTBOX_POLL_INTERVAL_MS
  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let active: Promise<void> | null = null

  const scheduleNext = (): void => {
    if (stopped) {
      return
    }
    timer = setTimeout(() => {
      void tick()
    }, pollIntervalMs)
  }

  const tick = (): Promise<void> => {
    if (stopped || active) {
      return active ?? Promise.resolve()
    }

    active = dispatchPendingOutbox(options)
      .then((summary) => {
        if (summary.claimed > 0 || summary.failed > 0) {
          console.log('[outbox] Dispatch run finished', summary)
        }
      })
      .catch((error: unknown) => {
        console.error('[outbox] Dispatch run failed', error)
      })
      .finally(() => {
        active = null
        scheduleNext()
      })

    return active
  }

  void tick()

  return {
    runOnce: () => dispatchPendingOutbox(options),
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
