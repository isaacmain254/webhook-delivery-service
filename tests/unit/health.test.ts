import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  checkReadiness,
  livenessState,
  type HealthCheckDependencies,
} from '../../src/services/health.service.js'

function dependencies(
  overrides: Partial<HealthCheckDependencies> = {},
): HealthCheckDependencies {
  return {
    pingDb: vi.fn().mockResolvedValue(undefined),
    pingRedis: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('checkReadiness', () => {
  beforeAll(() => {
    vi.useFakeTimers()
  })

  afterAll(() => {
    vi.useRealTimers()
  })

  it('reports ok when every dependency probe succeeds', async () => {
    const state = await checkReadiness(dependencies())

    expect(state).toEqual({ status: 'ok', db: 'ok', redis: 'ok' })
  })

  it('degrades when the database probe fails', async () => {
    const state = await checkReadiness(
      dependencies({ pingDb: vi.fn().mockRejectedValue(new Error('connection refused')) }),
    )

    expect(state).toEqual({ status: 'degraded', db: 'unavailable', redis: 'ok' })
  })

  it('degrades when the Redis probe fails', async () => {
    const state = await checkReadiness(
      dependencies({ pingRedis: vi.fn().mockRejectedValue(new Error('Redis down')) }),
    )

    expect(state).toEqual({ status: 'degraded', db: 'ok', redis: 'unavailable' })
  })

  it('marks a hung probe unavailable instead of never resolving', async () => {
    const hang = () => new Promise<void>(() => undefined)

    const pending = checkReadiness(dependencies({ pingDb: hang, pingRedis: hang }))
    await vi.advanceTimersByTimeAsync(2_000)
    const state = await pending

    expect(state).toEqual({ status: 'degraded', db: 'unavailable', redis: 'unavailable' })
  })
})

describe('livenessState', () => {
  it('never depends on external services', () => {
    expect(livenessState()).toEqual({ status: 'ok' })
  })
})
