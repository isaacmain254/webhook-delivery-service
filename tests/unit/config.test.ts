import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.js'

const baseEnv = {
  DATABASE_URL: 'postgresql://user:password@localhost:5432/webhooks',
  API_KEY_HASH_SECRET: 'x'.repeat(32),
}

describe('loadConfig', () => {
  it('applies worker shutdown and retry defaults', () => {
    const config = loadConfig(baseEnv)

    expect(config.WORKER_SHUTDOWN_TIMEOUT_MS).toBe(45_000)
    expect(config.MAX_DELIVERY_ATTEMPTS).toBe(5)
    expect(config.INITIAL_RETRY_DELAY_MS).toBe(1_000)
    expect(config.MAX_RETRY_DELAY_MS).toBe(3_600_000)
    expect(config.LOG_LEVEL).toBe('info')
    expect(config.WORKER_HEALTH_PORT).toBe(5001)
  })

  it('raises the log level from LOG_LEVEL', () => {
    const config = loadConfig({ ...baseEnv, LOG_LEVEL: 'warn' })
    expect(config.LOG_LEVEL).toBe('warn')
  })

  it('accepts the silent log level for fully quiet output', () => {
    const config = loadConfig({ ...baseEnv, LOG_LEVEL: 'silent' })
    expect(config.LOG_LEVEL).toBe('silent')
  })

  it('rejects an unsupported LOG_LEVEL', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        LOG_LEVEL: 'VERBOSE',
      }),
    ).toThrow(/LOG_LEVEL/)
  })

  it('parses and validates the worker health port', () => {
    const config = loadConfig({ ...baseEnv, WORKER_HEALTH_PORT: '5100' })
    expect(config.WORKER_HEALTH_PORT).toBe(5100)
  })

  it('rejects a worker health port that collides with PORT', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        PORT: '8080',
        WORKER_HEALTH_PORT: '8080',
      }),
    ).toThrow(/WORKER_HEALTH_PORT: must not collide with PORT/)
  })

  it('requires the worker lease to outlast an in-flight request', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        DELIVERY_TIMEOUT_MS: '5000',
        LEASE_DURATION_MS: '5000',
      }),
    ).toThrow(/LEASE_DURATION_MS: must be greater than DELIVERY_TIMEOUT_MS/)
  })

  it('requires the initial retry delay not to exceed the maximum', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        INITIAL_RETRY_DELAY_MS: '2000',
        MAX_RETRY_DELAY_MS: '1000',
      }),
    ).toThrow(/INITIAL_RETRY_DELAY_MS: must not exceed MAX_RETRY_DELAY_MS/)
  })

  it('requires the event payload limit not to exceed the JSON body limit', () => {
    expect(() =>
      loadConfig({
        ...baseEnv,
        JSON_BODY_LIMIT_BYTES: '1024',
        MAX_EVENT_PAYLOAD_BYTES: '2048',
      }),
    ).toThrow(/MAX_EVENT_PAYLOAD_BYTES: must not exceed JSON_BODY_LIMIT_BYTES/)
  })
})
