import config from './config.js'
import prisma from './db.js'
import { createBullMqDeliveryQueue } from './lib/delivery-queue.js'
import { startOutboxDispatcher } from './services/outbox.service.js'
import { startSchedulingReconciler } from './services/reconciliation.service.js'
import { createDeliveryWorker } from './workers/delivery.worker.js'
import {
  shutdownWorker,
  type WorkerShutdownRuntime,
} from './workers/shutdown.js'

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

const shutdownRuntime: WorkerShutdownRuntime = {
  stopDispatcher: () => dispatcher.stop(),
  stopReconciler: () => reconciler.stop(),
  closeWorker: () => deliveryWorker.close(),
  forceCloseWorker: () => deliveryWorker.close(true),
  closeQueue: () => queue.close(),
  disconnect: () => prisma.$disconnect(),
}

console.log('[worker] Delivery worker, outbox dispatcher, and reconciler started', {
  concurrency: config.WORKER_CONCURRENCY,
  pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  batchSize: config.OUTBOX_BATCH_SIZE,
  reconcileIntervalMs: config.OUTBOX_RECONCILE_INTERVAL_MS,
  shutdownTimeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS,
})

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    console.error(`[worker] Received ${signal} during shutdown; exiting immediately`)
    process.exit(1)
  }

  shuttingDown = true
  console.log(`[worker] Received ${signal}; stopping delivery worker and outbox loops`)

  try {
    const result = await shutdownWorker(shutdownRuntime, {
      timeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS,
    })
    process.exit(result.clean ? 0 : 1)
  } catch (error) {
    console.error('[worker] Shutdown failed unexpectedly', error)
    process.exit(1)
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
