import { describe, expect, it, vi } from 'vitest'
import {
  SsrfError,
  createPinnedLookup,
  isProhibitedAddress,
  validateWebhookUrl,
  type AddressResolver,
  type ResolvedAddress,
} from '../../src/lib/ssrf.js'

const ipv4 = (address: string): ResolvedAddress => ({ address, family: 4 })
const ipv6 = (address: string): ResolvedAddress => ({ address, family: 6 })

function resolverReturning(...addresses: ResolvedAddress[]): AddressResolver {
  return async () => addresses
}

async function expectSsrfError(promise: Promise<unknown>, code: string): Promise<SsrfError> {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(SsrfError)
    const ssrfError = error as SsrfError
    expect(ssrfError.code).toBe(code)
    return ssrfError
  }

  throw new Error('Expected validateWebhookUrl to reject the destination')
}

describe('validateWebhookUrl', () => {
  it('accepts an HTTPS hostname that resolves to a public address', async () => {
    const result = await validateWebhookUrl('https://hooks.example.com/payment', {
      lookup: resolverReturning(ipv4('93.184.216.34')),
    })

    expect(result.url.href).toBe('https://hooks.example.com/payment')
    expect(result.addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('accepts a public IP literal without resolving DNS', async () => {
    const lookup = vi.fn<AddressResolver>()

    const result = await validateWebhookUrl('https://93.184.216.34/hook', { lookup })

    expect(result.addresses).toEqual([{ address: '93.184.216.34', family: 4 }])
    expect(lookup).not.toHaveBeenCalled()
  })

  it.each(['8.8.8.8', '2606:4700:4700::1111', '::ffff:8.8.8.8'])(
    'accepts the public IP literal %s',
    async (address) => {
      const host = address.includes(':') ? `[${address}]` : address
      await expect(validateWebhookUrl(`https://${host}/hook`)).resolves.toBeDefined()
    },
  )

  it('rejects HTTP destinations when HTTPS is required', async () => {
    await expectSsrfError(
      validateWebhookUrl('http://hooks.example.com/payment', {
        requireHttps: true,
        lookup: resolverReturning(ipv4('93.184.216.34')),
      }),
      'HTTPS_REQUIRED',
    )
  })

  it('allows HTTP destinations when HTTPS is not required', async () => {
    const result = await validateWebhookUrl('http://hooks.example.com/payment', {
      requireHttps: false,
      lookup: resolverReturning(ipv4('93.184.216.34')),
    })

    expect(result.url.protocol).toBe('http:')
  })

  it.each(['ftp://93.184.216.34/file', 'file:///etc/passwd', 'gopher://93.184.216.34/'])(
    'rejects the non-HTTP protocol in %s',
    async (url) => {
      await expectSsrfError(validateWebhookUrl(url), 'INVALID_DESTINATION')
    },
  )

  it('rejects URLs containing credentials', async () => {
    await expectSsrfError(
      validateWebhookUrl('https://user:secret@93.184.216.34/hook'),
      'INVALID_DESTINATION',
    )
  })

  it('rejects malformed URLs', async () => {
    await expectSsrfError(validateWebhookUrl('not-a-url'), 'INVALID_DESTINATION')
  })

  it.each([
    ['0.0.0.0', 'unspecified'],
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private 10/8'],
    ['172.16.0.1', 'private 172.16/12'],
    ['192.168.1.10', 'private 192.168/16'],
    ['169.254.169.254', 'cloud metadata'],
    ['100.64.0.1', 'carrier-grade NAT'],
    ['192.0.2.5', 'TEST-NET-1'],
    ['198.18.0.1', 'benchmarking'],
    ['198.51.100.1', 'TEST-NET-2'],
    ['203.0.113.1', 'TEST-NET-3'],
    ['224.0.0.1', 'multicast'],
    ['240.0.0.1', 'reserved'],
    ['255.255.255.255', 'broadcast'],
    ['::', 'IPv6 unspecified'],
    ['::1', 'IPv6 loopback'],
    ['fc00::1', 'IPv6 unique-local'],
    ['fd12:3456::1', 'IPv6 unique-local'],
    ['fe80::1', 'IPv6 link-local'],
    ['ff02::1', 'IPv6 multicast'],
    ['100::1', 'IPv6 discard-only'],
    ['2001:db8::1', 'IPv6 documentation'],
    ['::ffff:127.0.0.1', 'IPv4-mapped loopback'],
    ['::ffff:192.168.0.1', 'IPv4-mapped private'],
    ['::ffff:7f00:1', 'IPv4-mapped loopback in hex'],
  ])('rejects the prohibited IP literal %s (%s)', async (address) => {
    const host = address.includes(':') ? `[${address}]` : address
    await expectSsrfError(validateWebhookUrl(`https://${host}/hook`), 'INVALID_DESTINATION')
  })

  it.each(['metadata.google.internal', 'metadata.goog', 'localhost', 'hooks.localhost', 'LOCALHOST'])(
    'rejects the blocklisted hostname %s without resolving it',
    async (hostname) => {
      const lookup = vi.fn<AddressResolver>()

      await expectSsrfError(
        validateWebhookUrl(`https://${hostname}/hook`, { lookup }),
        'INVALID_DESTINATION',
      )
      expect(lookup).not.toHaveBeenCalled()
    },
  )

  it('rejects a hostname that resolves to a private address', async () => {
    await expectSsrfError(
      validateWebhookUrl('https://hooks.example.com/payment', {
        lookup: resolverReturning(ipv4('10.0.0.5')),
      }),
      'INVALID_DESTINATION',
    )
  })

  it('rejects a hostname when any resolved address is prohibited', async () => {
    await expectSsrfError(
      validateWebhookUrl('https://hooks.example.com/payment', {
        lookup: resolverReturning(ipv4('93.184.216.34'), ipv6('fd00::5')),
      }),
      'INVALID_DESTINATION',
    )
  })

  it('rejects when DNS resolution fails', async () => {
    const lookup: AddressResolver = async () => {
      throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })
    }

    await expectSsrfError(
      validateWebhookUrl('https://missing.example.com/hook', { lookup }),
      'INVALID_DESTINATION',
    )
  })

  it('rejects when DNS returns no addresses', async () => {
    await expectSsrfError(
      validateWebhookUrl('https://empty.example.com/hook', { lookup: resolverReturning() }),
      'INVALID_DESTINATION',
    )
  })
})

describe('isProhibitedAddress', () => {
  it('fails closed for malformed input', () => {
    expect(isProhibitedAddress('not-an-ip')).toBe(true)
    expect(isProhibitedAddress('999.1.1.1')).toBe(true)
    expect(isProhibitedAddress('')).toBe(true)
  })

  it('unwraps bracketed IPv6 literals', () => {
    expect(isProhibitedAddress('[::1]')).toBe(true)
    expect(isProhibitedAddress('[2606:4700:4700::1111]')).toBe(false)
  })

  it('allows public addresses', () => {
    expect(isProhibitedAddress('93.184.216.34')).toBe(false)
    expect(isProhibitedAddress('8.8.8.8')).toBe(false)
    expect(isProhibitedAddress('2606:4700:4700::1111')).toBe(false)
    expect(isProhibitedAddress('::ffff:8.8.8.8')).toBe(false)
  })
})

describe('createPinnedLookup', () => {
  it('returns only the validated address and never consults DNS again', () => {
    const lookup = createPinnedLookup([ipv4('93.184.216.34')])
    const callback = vi.fn()

    lookup('rebinding.example.com', { family: 4, all: false }, callback)

    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  })

  it('returns the validated address list in all: true mode', () => {
    const addresses = [ipv4('93.184.216.34'), ipv6('2606:4700:4700::1111')]
    const lookup = createPinnedLookup(addresses)
    const callback = vi.fn()

    lookup('example.com', { all: true }, callback)

    expect(callback).toHaveBeenCalledWith(null, addresses)
  })

  it('honours the requested address family', () => {
    const lookup = createPinnedLookup([ipv6('2606:4700:4700::1111'), ipv4('93.184.216.34')])
    const callback = vi.fn()

    lookup('example.com', { family: 4, all: false }, callback)

    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4)
  })

  it('rejects an empty address list', () => {
    expect(() => createPinnedLookup([])).toThrow(/at least one validated address/)
  })
})
