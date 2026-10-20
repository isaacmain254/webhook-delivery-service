import { beforeEach, describe, expect, it, vi } from 'vitest'
import config from '../../src/config.js'
import {
  DELIVERY_QUEUE_NAME,
  type DeliveryJobData,
} from '../../src/lib/delivery-queue.js'

const mocks = vi.hoisted(() => ({
  constructor: vi.fn(),
  on: vi.fn(),
  close: vi.fn(),
}))

vi.mock('bullmq', () => {
  class Worker {
    constructor(...args: unknown[]) {
      mocks.constructor(...args)
    }

    on(...args: unknown[]) {
      return mocks.on(...args)
    }

    close(...args: unknown[]) {
      return mocks.close(...args)
    }
  }

  return { Worker }
})

import { createDeliveryWorker } from '../../src/workers/delivery.worker.js'

beforeEach(() => {
  vi.resetAllMocks()
})

describe('createDeliveryWorker', () => {
  it('configures the queue, blocking connection, and concurrency', () => {
    createDeliveryWorker()

    expect(mocks.constructor).toHaveBeenCalledWith(
      DELIVERY_QUEUE_NAME,
      expect.any(Function),
      {
        connection: {
          url: config.REDIS_URL,
          maxRetriesPerRequest: null,
        },
        concurrency: config.WORKER_CONCURRENCY,
      },
    )
    expect(mocks.on).toHaveBeenCalledWith('error', expect.any(Function))
    expect(mocks.on).toHaveBeenCalledWith('failed', expect.any(Function))
  })

  it('delegates job processing using only the delivery ID', async () => {
    const processDelivery = vi.fn().mockResolvedValue({
      deliveryId: 'delivery-1',
      outcome: 'succeeded',
      attemptCount: 1,
    })
    createDeliveryWorker({ processDelivery })

    const processor = mocks.constructor.mock.calls[0]?.[1] as (
      job: { data: DeliveryJobData },
    ) => Promise<unknown>

    await expect(
      processor({ data: { deliveryId: 'delivery-1' } }),
    ).resolves.toEqual({
      deliveryId: 'delivery-1',
      outcome: 'succeeded',
      attemptCount: 1,
    })
    expect(processDelivery).toHaveBeenCalledWith('delivery-1')
  })

  it('rejects malformed jobs without invoking the processor', async () => {
    const processDelivery = vi.fn()
    createDeliveryWorker({ processDelivery })

    const processor = mocks.constructor.mock.calls[0]?.[1] as (
      job: { data: Partial<DeliveryJobData> },
    ) => Promise<unknown>

    await expect(processor({ data: {} })).rejects.toThrow(
      'Delivery job is missing a valid deliveryId',
    )
    expect(processDelivery).not.toHaveBeenCalled()
  })
})
