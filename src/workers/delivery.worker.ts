import { Worker, type Job } from 'bullmq'
import config from '../config.js'
import {
  DELIVERY_QUEUE_NAME,
  type DeliveryJobData,
} from '../lib/delivery-queue.js'
import {
  processDeliveryJob,
  type DeliveryProcessResult,
} from '../services/delivery.service.js'

export type DeliveryJobProcessor = (
  deliveryId: string,
) => Promise<DeliveryProcessResult>

export interface CreateDeliveryWorkerOptions {
  /** Injectable for tests; production delegates to processDeliveryJob. */
  processDelivery?: DeliveryJobProcessor
}

export function createDeliveryWorker(
  options: CreateDeliveryWorkerOptions = {},
): Worker<DeliveryJobData> {
  const processDelivery =
    options.processDelivery ??
    ((deliveryId: string) => processDeliveryJob(deliveryId))

  const worker = new Worker<DeliveryJobData>(
    DELIVERY_QUEUE_NAME,
    async (job: Job<DeliveryJobData>) => {
      const deliveryId = job.data?.deliveryId
      if (typeof deliveryId !== 'string' || deliveryId.length === 0) {
        throw new Error('Delivery job is missing a valid deliveryId')
      }

      return processDelivery(deliveryId)
    },
    {
      connection: {
        url: config.REDIS_URL,
        // BullMQ requires this to be null for blocking worker connections.
        maxRetriesPerRequest: null,
      },
      concurrency: config.WORKER_CONCURRENCY,
    },
  )

  worker.on('error', (error: Error) => {
    console.error('[worker] BullMQ worker error', error.message)
  })

  worker.on('failed', (job, error: Error) => {
    console.error('[worker] Delivery job failed', {
      jobId: job?.id,
      deliveryId: job?.data?.deliveryId,
      error: error.message,
    })
  })

  return worker
}
