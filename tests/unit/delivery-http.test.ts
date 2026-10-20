import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DeliveryTransportError,
  createHttpDeliveryTransport,
  type WebhookHttpRequest,
} from '../../src/lib/delivery-http.js'
import { SsrfError } from '../../src/lib/ssrf.js'

const servers: http.Server[] = []

async function startServer(
  handler: http.RequestListener,
): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(handler)
  server.on('clientError', (_error, socket) => {
    socket.destroy()
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })

  servers.push(server)
  const address = server.address() as AddressInfo

  return { server, baseUrl: `http://127.0.0.1:${address.port}` }
}

function localTransport(options: { maxResponseBodyBytes?: number } = {}) {
  return createHttpDeliveryTransport({
    requireHttps: false,
    maxResponseBodyBytes: options.maxResponseBodyBytes ?? 1_024,
    validateDestination: async (rawUrl) => ({
      url: new URL(rawUrl),
      addresses: [{ address: '127.0.0.1', family: 4 }],
    }),
  })
}

function request(baseUrl: string, overrides: Partial<WebhookHttpRequest> = {}): WebhookHttpRequest {
  return {
    url: `${baseUrl}/webhook`,
    headers: {
      'content-type': 'application/json',
      'x-test-header': 'test-value',
    },
    body: Buffer.from('{"amount":1000}', 'utf8'),
    timeoutMs: 1_000,
    ...overrides,
  }
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

describe('HTTP delivery transport', () => {
  it('sends the exact body with the supplied headers using POST', async () => {
    let received:
      | { method: string | undefined; headers: http.IncomingHttpHeaders; body: string }
      | undefined

    const { baseUrl } = await startServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (chunk: Buffer) => chunks.push(chunk))
      req.on('end', () => {
        received = {
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.end('ok')
      })
    })

    const response = await localTransport().send(request(baseUrl))

    expect(response).toEqual({ statusCode: 200, body: 'ok', truncated: false })
    expect(received).toEqual({
      method: 'POST',
      headers: expect.objectContaining({
        'content-type': 'application/json',
        'x-test-header': 'test-value',
        'content-length': '15',
      }),
      body: '{"amount":1000}',
    })
  })

  it('bounds response-body reads and reports truncation', async () => {
    const { baseUrl } = await startServer((_req, res) => {
      res.on('error', () => {})
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('0123456789')
    })

    const response = await localTransport({ maxResponseBodyBytes: 4 }).send(
      request(baseUrl),
    )

    expect(response).toEqual({ statusCode: 200, body: '0123', truncated: true })
  })

  it('rejects with TIMEOUT when the receiver does not finish in time', async () => {
    const { baseUrl } = await startServer(() => {
      // Intentionally never respond.
    })

    const error = await localTransport()
      .send(request(baseUrl, { timeoutMs: 50 }))
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(DeliveryTransportError)
    expect((error as DeliveryTransportError).code).toBe('TIMEOUT')
  })

  it('does not follow redirects', async () => {
    let requests = 0
    const { baseUrl } = await startServer((_req, res) => {
      requests += 1
      res.writeHead(302, { location: '/somewhere-else' })
      res.end()
    })

    const response = await localTransport().send(request(baseUrl))

    expect(response.statusCode).toBe(302)
    expect(requests).toBe(1)
  })

  it('propagates destination-policy rejections', async () => {
    const transport = createHttpDeliveryTransport({
      requireHttps: false,
      validateDestination: async () => {
        throw new SsrfError('INVALID_DESTINATION', 'Destination URL is not allowed')
      },
    })

    await expect(transport.send(request('http://example.test/webhook'))).rejects.toBeInstanceOf(
      SsrfError,
    )
  })
})
