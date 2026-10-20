import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import config from '../config.js'
import {
  createPinnedLookup,
  validateWebhookUrl,
  type ValidatedWebhookUrl,
} from './ssrf.js'

export interface WebhookHttpRequest {
  url: string
  headers: Record<string, string>
  body: Buffer
  timeoutMs: number
}

export interface WebhookHttpResponse {
  statusCode: number
  body: string
  truncated: boolean
}

export interface DeliveryTransport {
  send(request: WebhookHttpRequest): Promise<WebhookHttpResponse>
}

export type DeliveryTransportErrorCode = 'TIMEOUT' | 'NETWORK_ERROR'

/**
 * A sanitized transport failure. The message is deliberately generic so
 * network details and resolved addresses do not end up in attempt history.
 */
export class DeliveryTransportError extends Error {
  readonly code: DeliveryTransportErrorCode

  constructor(code: DeliveryTransportErrorCode) {
    super(code === 'TIMEOUT' ? 'Delivery request timed out' : 'Delivery request failed')
    this.name = 'DeliveryTransportError'
    this.code = code
  }
}

export interface HttpDeliveryTransportOptions {
  maxResponseBodyBytes?: number
  requireHttps?: boolean
  /** Injectable policy hook so tests can use local loopback servers. */
  validateDestination?: (rawUrl: string) => Promise<ValidatedWebhookUrl>
}

/**
 * Creates the production outbound HTTP transport.
 *
 * Destinations are revalidated on every delivery and the request uses the
 * exact validated addresses through a pinned lookup. This prevents DNS
 * rebinding between endpoint registration and delivery.
 */
export function createHttpDeliveryTransport(
  options: HttpDeliveryTransportOptions = {},
): DeliveryTransport {
  const maxResponseBodyBytes =
    options.maxResponseBodyBytes ?? config.MAX_RESPONSE_BODY_BYTES
  const requireHttps =
    options.requireHttps ??
    (config.REQUIRE_HTTPS_DESTINATIONS || config.NODE_ENV === 'production')
  const validateDestination =
    options.validateDestination ??
    ((rawUrl: string) => validateWebhookUrl(rawUrl, { requireHttps }))

  return {
    async send(request) {
      const destination = await validateDestination(request.url)
      const lookup = createPinnedLookup(destination.addresses)

      return sendHttpRequest(
        destination.url,
        request,
        lookup as unknown as LookupFunction,
        maxResponseBodyBytes,
      )
    },
  }
}

function sendHttpRequest(
  url: URL,
  request: WebhookHttpRequest,
  lookup: LookupFunction,
  maxResponseBodyBytes: number,
): Promise<WebhookHttpResponse> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http
    const controller = new AbortController()
    let settled = false
    let timedOut = false

    const transportError = (): DeliveryTransportError =>
      new DeliveryTransportError(timedOut ? 'TIMEOUT' : 'NETWORK_ERROR')

    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, request.timeoutMs)

    const finish = (callback: () => void): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      callback()
    }

    const outbound = transport.request(
      url,
      {
        method: 'POST',
        headers: request.headers,
        lookup,
        signal: controller.signal,
      },
      (response) => {
        const chunks: Buffer[] = []
        let bytesRead = 0
        let truncated = false

        const complete = (): void => {
          finish(() => {
            resolve({
              statusCode: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf8'),
              truncated,
            })
          })
        }

        response.on('data', (chunk: Buffer | string) => {
          if (settled) {
            return
          }

          const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          const remaining = maxResponseBodyBytes - bytesRead

          if (remaining <= 0) {
            truncated = true
            complete()
            response.destroy()
            return
          }

          if (buffer.length > remaining) {
            chunks.push(buffer.subarray(0, remaining))
            bytesRead += remaining
            truncated = true
            complete()
            response.destroy()
            return
          }

          chunks.push(buffer)
          bytesRead += buffer.length
        })

        response.on('end', complete)
        response.on('error', () => {
          finish(() => reject(transportError()))
        })
        response.on('close', () => {
          if (!response.complete && !truncated) {
            finish(() => reject(transportError()))
          }
        })
      },
    )

    outbound.on('error', () => {
      finish(() => reject(transportError()))
    })

    outbound.end(request.body)
  })
}
