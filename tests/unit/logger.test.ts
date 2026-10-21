import { Writable } from 'node:stream'
import { describe, expect, it, type MockInstance, vi } from 'vitest'
import {
  createConsoleLikeLogger,
  createLogger,
  httpLoggerSerializers,
  logger,
  serializeError,
} from '../../src/lib/logger.js'

interface CapturingDestination {
  writable: NodeJS.WritableStream
  lines(): Array<Record<string, unknown>>
  toString(): string
}

function capturingDestination(): CapturingDestination {
  const chunks: string[] = []
  const writable = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'))
      callback()
    },
  })

  function lines(): Array<Record<string, unknown>> {
    return chunks
      .join('')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
  }

  return {
    writable,
    lines,
    toString: () => chunks.join(''),
  }
}

describe('structured logger', () => {
  it('writes one JSON object per line with level/timestamp/message', () => {
    const capture = capturingDestination()
    const testLogger = createLogger('info', capture.writable)

    testLogger.info({ userId: 'u-1' }, 'Something happened')

    const lines = capture.lines()
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      level: 30,
      time: expect.any(Number),
      userId: 'u-1',
      msg: 'Something happened',
    })
  })

  it('respects the configured level threshold', () => {
    const capture = capturingDestination()
    const testLogger = createLogger('warn', capture.writable)

    testLogger.info('quiet info message')
    testLogger.warn('loud warning message')

    const messages = capture.lines().map((line) => line.msg)
    expect(messages).toEqual(['loud warning message'])
  })

  it('removes sensitive keys from nested context objects', () => {
    const capture = capturingDestination()
    const testLogger = createLogger('info', capture.writable)

    testLogger.info(
      {
        requestId: 'rid-1',
        apiKey: 'sk_live_secret',
        signingSecret: 'whsec_secret',
        user: { apiKey: 'sk_nested_secret' },
        deep: { apiKey: 'sk_deep_secret' },
        eventPayload: { paymentId: 'pay_1' },
      },
      'Handled request',
    )

    const raw = capture.toString()
    expect(raw).not.toContain('sk_live_secret')
    expect(raw).not.toContain('whsec_secret')
    expect(raw).not.toContain('sk_nested_secret')
    expect(raw).not.toContain('sk_deep_secret')
    expect(raw).not.toContain('paymentId')
    expect(String(capture.lines()[0]?.requestId)).toBe('rid-1')
  })

  it('serializes errors into a plain object', () => {
    const capture = capturingDestination()
    const testLogger = createLogger('info', capture.writable)

    testLogger.info({ error: new Error('boom') }, 'Failed request')

    const [line] = capture.lines()
    expect(line?.error).toEqual({
      type: 'Error',
      message: 'boom',
      stack: expect.any(String),
    })
  })

  it('serializes unknown thrown values', () => {
    expect(serializeError(new TypeError('oops'))).toMatchObject({
      type: 'TypeError',
      message: 'oops',
    })
    expect(serializeError('plain')).toEqual({ message: 'plain' })
    expect(serializeError(undefined)).toEqual({})
    expect(serializeError(42)).toEqual({ message: '42' })
  })

  it('serializes requests without logging headers or other sensitive data', () => {
    const serialized = httpLoggerSerializers.req({
      method: 'POST',
      url: '/v1/events',
      id: 'rid-1',
      requestId: 'rid-1',
      headers: {
        'x-api-key': 'sk_secret_api_key',
        authorization: 'Bearer sk_another_secret',
      },
    })

    expect(serialized).toEqual({
      method: 'POST',
      url: '/v1/events',
      requestId: 'rid-1',
    })
    expect(JSON.stringify(serialized)).not.toContain('sk_secret_api_key')
  })

  it('serializes responses to nothing but the status code', () => {
    expect(httpLoggerSerializers.res({ statusCode: 202 })).toEqual({
      statusCode: 202,
    })
  })
})

describe('createConsoleLikeLogger', () => {
  function recorder(): {
    logger: Record<string, MockInstance>
    calls: Array<{ obj: object; msg: string }>
  } {
    const calls: Array<{ obj: object; msg: string }> = []
    const capture = (obj: object, msg: string) => calls.push({ obj, msg })
    const logger = {
      info: vi.fn(capture),
      warn: vi.fn(capture),
      error: vi.fn(capture),
    }
    return { logger, calls }
  }

  it('passes message strings as the pino message and objects as context', () => {
    const { logger: recorded, calls } = recorder()
    const adapter = createConsoleLikeLogger(recorded as never)
    adapter.log('Shutdown complete', { clean: true, forced: false })

    expect(calls).toEqual([
      { obj: { clean: true, forced: false }, msg: 'Shutdown complete' },
    ])
  })

  it('routes trailing Error arguments through serializeError', () => {
    const { logger: recorded, calls } = recorder()
    const adapter = createConsoleLikeLogger(recorded as never)
    const error = new Error('bad')

    adapter.error('Job failed', error)

    expect(calls[0]?.obj).toEqual({ error: serializeError(error) })
    expect(calls[0]?.msg).toBe('Job failed')
  })

  it('maps log/warn/error onto info/warn/error levels', () => {
    const { logger: recorded, calls } = recorder()
    const adapter = createConsoleLikeLogger(recorded as never)

    adapter.log('one')
    adapter.warn('two')
    adapter.error('three')

    expect(calls.map((call) => call.msg)).toEqual(['one', 'two', 'three'])
  })

  it('defaults to the shared root logger', () => {
    const source = logger as unknown as {
      info: (obj: object, msg: string) => void
    }
    const info = vi.spyOn(source, 'info')

    const adapter = createConsoleLikeLogger(logger)
    adapter.log('root message', { key: 'value' })

    expect(info).toHaveBeenCalledWith({ key: 'value' }, 'root message')
    info.mockRestore()
  })
})
