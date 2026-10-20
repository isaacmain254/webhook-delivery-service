import { describe, expect, it, vi } from 'vitest'
import {
  shutdownWorker,
  type WorkerShutdownRuntime,
} from '../../src/workers/shutdown.js'

function silentLogger() {
  return {
    log: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
}

function runtime(
  overrides: Partial<WorkerShutdownRuntime> = {},
  order: string[] = [],
): WorkerShutdownRuntime {
  return {
    stopDispatcher: async () => {
      order.push('dispatcher')
    },
    stopReconciler: async () => {
      order.push('reconciler')
    },
    closeWorker: async () => {
      order.push('worker')
    },
    forceCloseWorker: async () => {
      order.push('force-worker')
    },
    closeQueue: async () => {
      order.push('queue')
    },
    disconnect: async () => {
      order.push('prisma')
    },
    ...overrides,
  }
}

describe('shutdownWorker', () => {
  it('stops scheduling, closes the worker, queue, and Prisma in order', async () => {
    const order: string[] = []
    const result = await shutdownWorker(runtime({}, order), {
      timeoutMs: 100,
      logger: silentLogger(),
    })

    expect(result).toEqual({ clean: true, forced: false, errors: [] })
    expect(order).toEqual(['dispatcher', 'reconciler', 'worker', 'queue', 'prisma'])
  })

  it('force-closes the worker after the shutdown timeout and continues cleanup', async () => {
    const order: string[] = []
    const logger = silentLogger()
    const result = await shutdownWorker(
      runtime(
        {
          closeWorker: () => {
            order.push('worker')
            return new Promise<void>(() => {})
          },
          forceCloseWorker: async () => {
            order.push('force-worker')
          },
        },
        order,
      ),
      { timeoutMs: 20, logger },
    )

    expect(result.clean).toBe(false)
    expect(result.forced).toBe(true)
    expect(order).toEqual([
      'dispatcher',
      'reconciler',
      'worker',
      'force-worker',
      'queue',
      'prisma',
    ])
    expect(logger.warn).toHaveBeenCalled()
  })

  it('continues cleanup when a scheduling loop fails to stop', async () => {
    const order: string[] = []
    const logger = silentLogger()
    const result = await shutdownWorker(
      runtime(
        {
          stopDispatcher: async () => {
            order.push('dispatcher')
            throw new Error('dispatcher stop failed')
          },
        },
        order,
      ),
      { timeoutMs: 100, logger },
    )

    expect(result.clean).toBe(false)
    expect(result.forced).toBe(false)
    expect(result.errors).toHaveLength(1)
    expect(order).toEqual(['dispatcher', 'reconciler', 'worker', 'queue', 'prisma'])
    expect(logger.error).toHaveBeenCalled()
  })

  it('reports worker close and queue close failures without skipping later cleanup', async () => {
    const order: string[] = []
    const result = await shutdownWorker(
      runtime(
        {
          closeWorker: async () => {
            order.push('worker')
            throw new Error('worker close failed')
          },
          closeQueue: async () => {
            order.push('queue')
            throw new Error('queue close failed')
          },
        },
        order,
      ),
      { timeoutMs: 100, logger: silentLogger() },
    )

    expect(result.clean).toBe(false)
    expect(result.errors).toHaveLength(2)
    expect(order).toEqual(['dispatcher', 'reconciler', 'worker', 'queue', 'prisma'])
  })

  it('bounds a hanging forced close and queue close', async () => {
    const result = await shutdownWorker(
      runtime({
        closeWorker: () => new Promise<void>(() => {}),
        forceCloseWorker: () => new Promise<void>(() => {}),
        closeQueue: () => new Promise<void>(() => {}),
      }),
      { timeoutMs: 10, logger: silentLogger() },
    )

    expect(result.clean).toBe(false)
    expect(result.forced).toBe(true)
    expect(result.errors).toHaveLength(2)
  })
})
