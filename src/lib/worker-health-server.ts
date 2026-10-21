import { createServer, type Server, type ServerResponse } from 'node:http'
import { logger } from './logger.js'

const JSON_TYPE = 'application/json'

export type WorkerHealthHttpServer = {
  /** Actual bound port; differs from input when a port of 0 was requested. */
  port: number
  /** Gracefully closes the HTTP listener (tests and worker shutdown). */
  close(): Promise<void>
}

export interface WorkerHealthServerOptions {
  /** Ports <= 0 bind an ephemeral port and return the real one via `.port`. */
  port: number
  pingDb: () => Promise<void>
  pingRedis: () => Promise<void>
  /** True once the worker begins its shutdown drain. */
  isStopping?: () => boolean
}

interface WorkerReadyState {
  status: 'ok' | 'degraded'
  db: 'ok' | 'unavailable'
  redis: 'ok' | 'unavailable'
  worker: 'running' | 'stopping'
}

const CHECK_TIMEOUT_MS = 2_000

async function probe(ping: () => Promise<void>): Promise<boolean> {
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('ping timed out')), CHECK_TIMEOUT_MS)
  })
  await Promise.race([ping(), timeout])
  return true
}

async function readyState(options: WorkerHealthServerOptions): Promise<WorkerReadyState> {
  const [dbResult, redisResult] = await Promise.allSettled([
    probe(options.pingDb),
    probe(options.pingRedis),
  ])

  const db = dbResult.status === 'fulfilled' ? 'ok' : 'unavailable'
  const redis = redisResult.status === 'fulfilled' ? 'ok' : 'unavailable'

  return {
    status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
    db,
    redis,
    worker: options.isStopping?.() ? 'stopping' : 'running',
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', JSON_TYPE)
  res.end(JSON.stringify(body))
}

function handleRequest(
  path: string | undefined,
  options: WorkerHealthServerOptions,
  res: ServerResponse,
): void {
  if (path === '/live') {
    sendJson(res, 200, { status: 'ok' })
    return
  }

  if (path === '/ready') {
    readyState(options)
      .then((state) => sendJson(res, state.status === 'ok' ? 200 : 503, state))
      .catch(() => sendJson(res, 503, { status: 'degraded' }))
    return
  }

  sendJson(res, 404, { error: 'Not found' })
}

/**
 * Minimal in-process HTTP surface exposing worker liveness and readiness.
 * Lives only inside the worker process; the API keeps its own /v1/health surface.
 */
export async function startWorkerHealthServer(
  options: WorkerHealthServerOptions,
): Promise<WorkerHealthHttpServer> {
  const server = createServer((req, res) => {
    handleRequest(req.url, options, res)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, () => resolve())
  })

  const boundPort = (server.address() as { port: number }).port
  logger.info({ component: 'worker', port: boundPort }, '[worker] Health server started')

  return {
    port: boundPort,
    close() {
      return new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    },
  }
}
