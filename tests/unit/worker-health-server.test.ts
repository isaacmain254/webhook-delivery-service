import { afterEach, describe, expect, it, vi } from 'vitest'
import { startWorkerHealthServer } from '../../src/lib/worker-health-server.js'

async function fetchFrom(
  server: { port: number },
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${server.port}${path}`)
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  }
}

describe('worker health server', () => {
  let server: Awaited<ReturnType<typeof startWorkerHealthServer>> | undefined

  afterEach(async () => {
    if (server) {
      await server.close()
      server = undefined
    }
  })

  it('(re)binds on an ephemeral port when asked to', async () => {
    server = await startWorkerHealthServer({
      port: 0,
      pingDb: async () => undefined,
      pingRedis: async () => undefined,
    })

    expect(server.port).toBeGreaterThan(0)
  })

  it('exposes a process liveness endpoint without touching dependencies', async () => {
    const pingDb = vi.fn().mockRejectedValue(new Error('must not be called'))
    const pingRedis = vi.fn().mockRejectedValue(new Error('must not be called'))
    server = await startWorkerHealthServer({ port: 0, pingDb, pingRedis })

    const response = await fetchFrom(server, '/live')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ status: 'ok' })
    expect(pingDb).not.toHaveBeenCalled()
    expect(pingRedis).not.toHaveBeenCalled()
  })

  it('reports full readiness with dependency states', async () => {
    server = await startWorkerHealthServer({
      port: 0,
      pingDb: async () => undefined,
      pingRedis: async () => undefined,
    })

    const response = await fetchFrom(server, '/ready')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      status: 'ok',
      db: 'ok',
      redis: 'ok',
      worker: 'running',
    })
  })

  it('degrades /ready when a probe fails and exposes the worker state', async () => {
    server = await startWorkerHealthServer({
      port: 0,
      pingDb: vi.fn().mockResolvedValue(undefined),
      pingRedis: vi.fn().mockRejectedValue(new Error('Redis unavailable')),
      isStopping: () => true,
    })

    const response = await fetchFrom(server, '/ready')
    expect(response.status).toBe(503)
    expect(response.body).toEqual({
      status: 'degraded',
      db: 'ok',
      redis: 'unavailable',
      worker: 'stopping',
    })
  })

  it('replies 503 to /ready when a probe hangs and the guard trips', async () => {
    server = await startWorkerHealthServer({
      port: 0,
      pingDb: vi.fn().mockResolvedValue(undefined),
      pingRedis: () => new Promise<void>(() => undefined),
    })

    const response = await fetchFrom(server, '/ready')
    expect(response.status).toBe(503)
    expect(response.body).toMatchObject({
      status: 'degraded',
      redis: 'unavailable',
    })
  }, 5_000)

  it('returns 404 for unknown paths', async () => {
    server = await startWorkerHealthServer({
      port: 0,
      pingDb: async () => undefined,
      pingRedis: async () => undefined,
    })

    const response = await fetchFrom(server, '/nope')
    expect(response.status).toBe(404)
  })

  it('closes the HTTP listener on demand', async () => {
    server = await startWorkerHealthServer({
      port: 0,
      pingDb: async () => undefined,
      pingRedis: async () => undefined,
    })
    const port = server.port
    await server.close()
    server = undefined

    await expect(fetchFrom({ port }, '/live')).rejects.toThrow()
  })
})
