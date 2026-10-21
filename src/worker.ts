import config from './config.js'
import prisma from './db.js'
import { createBullMqDeliveryQueue } from './lib/delivery-queue.js'
import { closeHealthRedis, pingRedis } from './lib/health-redis.js'
import { createConsoleLikeLogger, logger } from './lib/logger.js'
import {
  startWorkerHealthServer,
  type WorkerHealthHttpServer,
} from './lib/worker-health-server.js'
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

/** Flips to true as soon as one shutdown drain begins; the /ready probe exposes it. */
let stopping = false

const healthServer: WorkerHealthHttpServer | null =
  config.WORKER_HEALTH_PORT > 0
    ? await startWorkerHealthServer({
        port: config.WORKER_HEALTH_PORT,
        pingDb: async () => {
          await prisma.$queryRaw`SELECT 1`
        },
        pingRedis,
        isStopping: () => stopping,
      })
    : null

const shutdownRuntime: WorkerShutdownRuntime = {
  stopDispatcher: () => dispatcher.stop(),
  stopReconciler: () => reconciler.stop(),
  closeWorker: () => deliveryWorker.close(),
  forceCloseWorker: () => deliveryWorker.close(true),
  closeQueue: () => queue.close(),
  disconnect: async () => {
    await prisma.$disconnect()
    await closeHealthRedis()
  },
}

logger.info(
  {
    component: 'worker',
    concurrency: config.WORKER_CONCURRENCY,
    pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
    batchSize: config.OUTBOX_BATCH_SIZE,
    reconcileIntervalMs: config.OUTBOX_RECONCILE_INTERVAL_MS,
    shutdownTimeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS,
  },
  '[worker] Delivery worker, outbox dispatcher, and reconciler started',
)

let shuttingDown = false

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    logger.error(`[worker] Received ${signal} during shutdown; exiting immediately`)
    process.exit(1)
  }

  shuttingDown = true
  // Exposed immediately so /ready stops advertising new work before the loops
  // actually halt.
  stopping = true
  logger.info(
    { signal },
    `[worker] Received ${signal}; stopping delivery worker and outbox loops`,
  )

  try {
    const result = await shutdownWorker(shutdownRuntime, {
      timeoutMs: config.WORKER_SHUTDOWN_TIMEOUT_MS,
      logger: createConsoleLikeLogger(logger),
    })

    if (healthServer) {
      await healthServer.close()
    }

    process.exit(result.clean ? 0 : 1)
  } catch (error) {
    logger.error({ error }, '[worker] Shutdown failed unexpectedly')
    process.exit(1)
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
