import { Queue } from 'bullmq'
import config from '../config.js'

export const DELIVERY_QUEUE_NAME = 'webhook-deliveries'
export const DELIVERY_JOB_NAME = 'deliver'

export interface DeliveryQueue {
  /** Adds one delivery job. BullMQ ignores duplicate job IDs that still exist. */
  enqueue(deliveryId: string, jobId: string): Promise<void>
  /** True while a job with this ID is retained by BullMQ. */
  hasJob(jobId: string): Promise<boolean>
  close(): Promise<void>
}

/**
 * Stable per scheduling cycle. A dispatcher crash after publishing but before
 * marking the outbox record published republishes with the same ID, so BullMQ
 * deduplicates it. Rescheduling (reconciliation, replay) bumps the generation.
 *
 * BullMQ rejects custom IDs containing ":" unless they have exactly three
 * segments, so hyphens are used deliberately.
 */
export function deliveryJobId(outboxRecordId: string, generation: number): string {
  return `delivery-${outboxRecordId}-g${generation}`
}

/**
 * BullMQ is only the scheduler; PostgreSQL remains the source of truth. BullMQ
 * attempts are disabled so application policy owns the delivery retry budget.
 */
export function createBullMqDeliveryQueue(): DeliveryQueue {
  const queue = new Queue<{ deliveryId: string }>(DELIVERY_QUEUE_NAME, {
    connection: {
      url: config.REDIS_URL,
      // Fail quickly while Redis is unavailable instead of holding a claim
      // until the outbox lease expires.
      maxRetriesPerRequest: 1,
    },
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: true,
      removeOnFail: true,
    },
  })

  queue.on('error', (error: Error) => {
    console.error('[queue] Redis connection error', error.message)
  })

  return {
    async enqueue(deliveryId, jobId) {
      await queue.add(DELIVERY_JOB_NAME, { deliveryId }, { jobId })
    },

    async hasJob(jobId) {
      return (await queue.getJob(jobId)) !== undefined
    },

    async close() {
      await queue.close()
    },
  }
}
