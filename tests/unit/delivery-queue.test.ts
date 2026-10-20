import { beforeEach, describe, expect, it, vi } from 'vitest'
import config from '../../src/config.js'

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  add: vi.fn(),
  getJob: vi.fn(),
  close: vi.fn(),
  on: vi.fn(),
}))

vi.mock('bullmq', () => {
  class Queue {
    constructor(...args: unknown[]) {
      mocks.constructor(...args)
    }

    add(...args: unknown[]) {
      return mocks.add(...args)
    }

    getJob(...args: unknown[]) {
      return mocks.getJob(...args)
    }

    close(...args: unknown[]) {
      return mocks.close(...args)
    }

    on(...args: unknown[]) {
      return mocks.on(...args)
    }
  }

  return { Queue }
})

import {
  createBullMqDeliveryQueue,
  deliveryJobId,
  DELIVERY_JOB_NAME,
  DELIVERY_QUEUE_NAME,
} from '../../src/lib/delivery-queue.js'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('deliveryJobId', () => {
  it('is stable and valid for BullMQ custom job IDs', () => {
    const jobId = deliveryJobId('3f1c2b1a-0000-4000-8000-000000000000', 2)

    expect(jobId).toBe('delivery-3f1c2b1a-0000-4000-8000-000000000000-g2')
    expect(jobId).not.toContain(':')
    expect(Number.isInteger(Number(jobId))).toBe(false)
  })
})

describe('createBullMqDeliveryQueue', () => {
  it('configures the queue from REDIS_URL without BullMQ retries', () => {
    createBullMqDeliveryQueue()

    expect(mocks.constructor).toHaveBeenCalledWith(
      DELIVERY_QUEUE_NAME,
      expect.objectContaining({
        connection: expect.objectContaining({
          url: config.REDIS_URL,
          maxRetriesPerRequest: 1,
        }),
        defaultJobOptions: expect.objectContaining({
          attempts: 1,
          removeOnComplete: true,
          removeOnFail: true,
        }),
      }),
    )
    expect(mocks.on).toHaveBeenCalledWith('error', expect.any(Function))
  })

  it('publishes only the delivery ID with the supplied stable job ID', async () => {
    const queue = createBullMqDeliveryQueue()

    await queue.enqueue('delivery-1', 'job-1')

    expect(mocks.add).toHaveBeenCalledWith(
      DELIVERY_JOB_NAME,
      { deliveryId: 'delivery-1' },
      { jobId: 'job-1' },
    )
  })

  it('reports whether a job is retained by the queue', async () => {
    mocks.getJob.mockResolvedValueOnce({ id: 'job-1' })
    mocks.getJob.mockResolvedValueOnce(undefined)

    const queue = createBullMqDeliveryQueue()

    await expect(queue.hasJob('job-1')).resolves.toBe(true)
    await expect(queue.hasJob('job-2')).resolves.toBe(false)
    expect(mocks.getJob).toHaveBeenNthCalledWith(1, 'job-1')
    expect(mocks.getJob).toHaveBeenNthCalledWith(2, 'job-2')
  })

  it('closes the underlying queue', async () => {
    const queue = createBullMqDeliveryQueue()

    await queue.close()

    expect(mocks.close).toHaveBeenCalledOnce()
  })
})
