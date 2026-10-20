import config from './config.js'
import prisma from './db.js'
import { createBullMqDeliveryQueue } from './lib/delivery-queue.js'
import { startOutboxDispatcher } from './services/outbox.service.js'
import { startSchedulingReconciler } from './services/reconciliation.service.js'
import { createDeliveryWorker } from './workers/delivery.worker.js'

const queue = createBullMqDeliveryQueue()
const deliveryWorker = createDeliveryWorker()

const dispatcher = startOutboxDispatcher({
  queue,
  pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  batchSize: config.OUTBOX_BATCH_SIZE,
  leaseDurationMs: config.OUTBOX_LEASE_DURATION_MS,
})

const reconciler = startSchedulingReconciler({
  queue,
  intervalMs: config.OUTBOX_RECONCILE_INTERVAL_MS,
  batchSize: config.OUTBOX_RECONCILE_BATCH_SIZE,
})

console.log('[worker] Delivery worker, outbox dispatcher, and reconciler started', {
  concurrency: config.WORKER_CONCURRENCY,
  pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  batchSize: config.OUTBOX_BATCH_SIZE,
  reconcileIntervalMs: config.OUTBOX_RECONCILE_INTERVAL_MS,
})

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return
  }

  shuttingDown = true
  console.log(`[worker] Received ${signal}; stopping delivery worker and outbox loops`)

  await Promise.allSettled([dispatcher.stop(), reconciler.stop()])
  await deliveryWorker.close().catch((error: unknown) => {
    console.error('[worker] Failed to close the BullMQ worker', error)
  })
  await queue.close().catch((error: unknown) => {
    console.error('[worker] Failed to close the delivery queue', error)
  })
  await prisma.$disconnect().catch((error: unknown) => {
    console.error('[worker] Failed to disconnect Prisma', error)
  })

  process.exit(0)
}

process.once('SIGINT', () => {
  void shutdown('SIGINT')
})
process.once('SIGTERM', () => {
  void shutdown('SIGTERM')
})
