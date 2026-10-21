import prisma from '../db.js'
import { pingRedis } from '../lib/health-redis.js'

/** How long any single dependency probe may run before being marked unavailable. */
const PING_TIMEOUT_MS = 2_000

export type HealthStatus = 'ok' | 'unavailable'

export type HealthState = {
  status: 'ok' | 'degraded'
  db: HealthStatus
  redis: HealthStatus
}

export type HealthPing = () => Promise<void>

export interface HealthCheckDependencies {
  pingDb?: HealthPing
  pingRedis?: HealthPing
}

async function pingDb(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`
}

/** Rejects if the probe does not settle within PING_TIMEOUT_MS. */
function withTimeout(ping: HealthPing, name: string): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${name} ping timed out after ${PING_TIMEOUT_MS}ms`))
    }, PING_TIMEOUT_MS)
  })

  return Promise.race([ping(), timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer)
    }
  })
}

/**
 * Runs both dependency probes concurrently and reports each independently, so
 * a single outage degrades rather than masks information about the other.
 */
export async function checkReadiness(
  dependencies: HealthCheckDependencies = {},
): Promise<HealthState> {
  const { pingDb: pingDbProbe = pingDb, pingRedis: pingRedisProbe = pingRedis } =
    dependencies

  const [dbResult, redisResult] = await Promise.allSettled([
    withTimeout(pingDbProbe, 'PostgreSQL'),
    withTimeout(pingRedisProbe, 'Redis'),
  ])

  const db = dbResult.status === 'fulfilled' ? 'ok' : 'unavailable'
  const redis = redisResult.status === 'fulfilled' ? 'ok' : 'unavailable'

  return {
    status: db === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
    db,
    redis,
  }
}

/** Always succeeds: liveness never depends on external services. */
export function livenessState(): { status: 'ok' } {
  return { status: 'ok' }
}
