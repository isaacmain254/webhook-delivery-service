export interface WorkerShutdownRuntime {
  stopDispatcher(): Promise<void>
  stopReconciler(): Promise<void>
  closeWorker(): Promise<void>
  forceCloseWorker(): Promise<void>
  closeQueue(): Promise<void>
  disconnect(): Promise<void>
}

export interface WorkerShutdownOptions {
  timeoutMs?: number
  logger?: Pick<Console, 'log' | 'warn' | 'error'>
}

export interface WorkerShutdownResult {
  clean: boolean
  forced: boolean
  errors: unknown[]
}

type SettledStep =
  | { status: 'completed' }
  | { status: 'timeout' }
  | { status: 'failed'; error: unknown }

function settleBeforeTimeout(
  promise: Promise<void>,
  timeoutMs: number,
): Promise<SettledStep> {
  let timer: NodeJS.Timeout | undefined

  const timeout = new Promise<SettledStep>((resolve) => {
    timer = setTimeout(() => resolve({ status: 'timeout' }), Math.max(0, timeoutMs))
  })

  const settled = promise.then(
    (): SettledStep => ({ status: 'completed' }),
    (error: unknown): SettledStep => ({ status: 'failed', error }),
  )

  return Promise.race([settled, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

/**
 * Stops scheduling, drains active delivery jobs within the configured timeout,
 * then closes BullMQ and Prisma resources. A timed-out worker is force-closed;
 * its abandoned delivery is later recovered by the database lease reconciler.
 */
export async function shutdownWorker(
  runtime: WorkerShutdownRuntime,
  options: WorkerShutdownOptions = {},
): Promise<WorkerShutdownResult> {
  const timeoutMs = options.timeoutMs ?? 45_000
  const logger = options.logger ?? console
  const errors: unknown[] = []
  let forced = false

  const loopResults = await Promise.allSettled([
    runtime.stopDispatcher(),
    runtime.stopReconciler(),
  ])

  for (const result of loopResults) {
    if (result.status === 'rejected') {
      errors.push(result.reason)
      logger.error('[worker] Failed to stop a scheduling loop during shutdown', result.reason)
    }
  }

  logger.log('[worker] Waiting for in-flight delivery jobs to finish')
  const workerClose = await settleBeforeTimeout(runtime.closeWorker(), timeoutMs)

  if (workerClose.status === 'failed') {
    errors.push(workerClose.error)
    logger.error('[worker] Failed to close the BullMQ worker', workerClose.error)
  } else if (workerClose.status === 'timeout') {
    forced = true
    logger.warn('[worker] Worker shutdown timed out; forcing the worker closed', {
      timeoutMs,
    })

    const forcedClose = await settleBeforeTimeout(
      runtime.forceCloseWorker(),
      timeoutMs,
    )

    if (forcedClose.status === 'failed') {
      errors.push(forcedClose.error)
      logger.error('[worker] Failed to force-close the BullMQ worker', forcedClose.error)
    } else if (forcedClose.status === 'timeout') {
      errors.push(new Error('Timed out while force-closing the BullMQ worker'))
      logger.error('[worker] Timed out while force-closing the BullMQ worker')
    }
  }

  const queueClose = await settleBeforeTimeout(runtime.closeQueue(), timeoutMs)
  if (queueClose.status === 'failed') {
    errors.push(queueClose.error)
    logger.error('[worker] Failed to close the delivery queue', queueClose.error)
  } else if (queueClose.status === 'timeout') {
    errors.push(new Error('Timed out while closing the delivery queue'))
    logger.error('[worker] Timed out while closing the delivery queue')
  }

  const disconnect = await settleBeforeTimeout(runtime.disconnect(), timeoutMs)
  if (disconnect.status === 'failed') {
    errors.push(disconnect.error)
    logger.error('[worker] Failed to disconnect Prisma', disconnect.error)
  } else if (disconnect.status === 'timeout') {
    errors.push(new Error('Timed out while disconnecting Prisma'))
    logger.error('[worker] Timed out while disconnecting Prisma')
  }

  const clean = errors.length === 0 && !forced
  logger.log('[worker] Shutdown complete', { clean, forced })

  return { clean, forced, errors }
}
