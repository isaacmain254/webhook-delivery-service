import { Redis } from 'ioredis'
import config from '../config.js'
import { logger } from './logger.js'

let healthRedis: Redis | undefined

/**
 * Lazily connects a long-lived Redis client used only for health pings so
 * readiness checks do not churn connections on every request.
 */
export function getHealthRedis(): Redis {
  healthRedis ??= new Redis(config.REDIS_URL, {
    lazyConnect: true,
    // A health probe must fail fast instead of waiting on a blocked queue.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  })

  // Redis emits errors whenever the connection drops; leaving that unhandled
  // would crash the process, and the health endpoint already reports the state.
  healthRedis.on('error', (error) => {
    logger.warn({ error }, '[health] Redis connection error')
  })

  return healthRedis
}

/** Runs one PING against the long-lived health client. */
export async function pingRedis(): Promise<void> {
  const client = getHealthRedis()

  // The client is created with lazyConnect, so the very first probe drives
  // the initial connection. Falling through to `ping()` while disconnected
  // would reject immediately because the offline queue is disabled.
  if (client.status === 'wait') {
    await client.connect()
  }

  await client.ping()
}

/** Closes the health Redis client. Used on API shutdown and in tests. */
export async function closeHealthRedis(): Promise<void> {
  if (!healthRedis) {
    return
  }
  const client = healthRedis
  healthRedis = undefined
  await client.quit().catch(() => client.disconnect())
}
