import { lookup as dnsLookup } from 'node:dns/promises'
import { BlockList, isIP } from 'node:net'
import { AppError } from './errors.js'

export type IpFamily = 4 | 6

export interface ResolvedAddress {
  address: string
  family: IpFamily
}

export type AddressResolver = (hostname: string) => Promise<ResolvedAddress[]>

export type SsrfErrorCode = 'HTTPS_REQUIRED' | 'INVALID_DESTINATION'

/**
 * Raised when a webhook destination is not allowed. Messages are safe to show
 * to API clients: they never include resolved/internal network details.
 */
export class SsrfError extends AppError {
  readonly code: SsrfErrorCode

  constructor(code: SsrfErrorCode, message: string) {
    super(422, code, message)
    this.code = code
  }
}

export interface ValidateWebhookUrlOptions {
  /** Reject plain HTTP destinations. Callers decide based on environment policy. */
  requireHttps?: boolean
  /** Injectable resolver so tests do not depend on real DNS. */
  lookup?: AddressResolver
}

export interface ValidatedWebhookUrl {
  url: URL
  addresses: ResolvedAddress[]
}

export interface PinnedLookupOptions {
  family?: number
  hints?: number
  all?: boolean
  verbatim?: boolean
}

export type PinnedLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | ResolvedAddress[],
  family?: number,
) => void

export type PinnedLookup = (
  hostname: string,
  options: PinnedLookupOptions,
  callback: PinnedLookupCallback,
) => void

const blockedIpv4 = new BlockList()
blockedIpv4.addSubnet('0.0.0.0', 8, 'ipv4') // "this network"
blockedIpv4.addSubnet('10.0.0.0', 8, 'ipv4') // private
blockedIpv4.addSubnet('100.64.0.0', 10, 'ipv4') // carrier-grade NAT
blockedIpv4.addSubnet('127.0.0.0', 8, 'ipv4') // loopback
blockedIpv4.addSubnet('169.254.0.0', 16, 'ipv4') // link-local, incl. 169.254.169.254 metadata
blockedIpv4.addSubnet('172.16.0.0', 12, 'ipv4') // private
blockedIpv4.addSubnet('192.0.0.0', 24, 'ipv4') // IETF protocol assignments
blockedIpv4.addSubnet('192.0.2.0', 24, 'ipv4') // TEST-NET-1
blockedIpv4.addSubnet('192.168.0.0', 16, 'ipv4') // private
blockedIpv4.addSubnet('198.18.0.0', 15, 'ipv4') // benchmarking
blockedIpv4.addSubnet('198.51.100.0', 24, 'ipv4') // TEST-NET-2
blockedIpv4.addSubnet('203.0.113.0', 24, 'ipv4') // TEST-NET-3
blockedIpv4.addSubnet('224.0.0.0', 4, 'ipv4') // multicast
blockedIpv4.addSubnet('240.0.0.0', 4, 'ipv4') // reserved, incl. 255.255.255.255

const blockedIpv6 = new BlockList()
blockedIpv6.addAddress('::', 'ipv6') // unspecified
blockedIpv6.addAddress('::1', 'ipv6') // loopback
blockedIpv6.addSubnet('64:ff9b::', 96, 'ipv6') // NAT64 (may embed a private IPv4)
blockedIpv6.addSubnet('100::', 64, 'ipv6') // discard-only
blockedIpv6.addSubnet('2001:2::', 48, 'ipv6') // benchmarking
blockedIpv6.addSubnet('2001:db8::', 32, 'ipv6') // documentation
blockedIpv6.addSubnet('fc00::', 7, 'ipv6') // unique-local
blockedIpv6.addSubnet('fe80::', 10, 'ipv6') // link-local
blockedIpv6.addSubnet('ff00::', 8, 'ipv6') // multicast

const blockedHostnames = new Set(['localhost', 'metadata.google.internal', 'metadata.goog'])

function normalizeAddress(address: string): ResolvedAddress | null {
  const family = isIP(address)
  if (family === 4) {
    return { address, family: 4 }
  }
  if (family === 6) {
    return { address: address.toLowerCase(), family: 6 }
  }
  return null
}

/**
 * Expands an IPv6 address into eight 16-bit groups. Returns null for invalid
 * input. Handles `::` compression and trailing IPv4 notation.
 */
function parseIpv6Groups(address: string): number[] | null {
  let normalized = address.toLowerCase()

  const lastColon = normalized.lastIndexOf(':')
  const tail = normalized.slice(lastColon + 1)
  if (tail.includes('.')) {
    const octets = tail.split('.')
    if (octets.length !== 4) {
      return null
    }
    const values = octets.map((octet) => Number.parseInt(octet, 10))
    if (values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      return null
    }
    const high = ((values[0] << 8) | values[1]).toString(16)
    const low = ((values[2] << 8) | values[3]).toString(16)
    normalized = `${normalized.slice(0, lastColon + 1)}${high}:${low}`
  }

  const halves = normalized.split('::')
  if (halves.length > 2) {
    return null
  }

  const parseGroups = (part: string): number[] | null => {
    if (part === '') {
      return []
    }
    const groups: number[] = []
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) {
        return null
      }
      groups.push(Number.parseInt(group, 16))
    }
    return groups
  }

  const head = parseGroups(halves[0])
  const tailGroups = halves.length === 2 ? parseGroups(halves[1]) : []
  if (!head || !tailGroups) {
    return null
  }

  if (halves.length === 1) {
    return head.length === 8 ? head : null
  }

  const missing = 8 - head.length - tailGroups.length
  if (missing < 0) {
    return null
  }
  return [...head, ...new Array<number>(missing).fill(0), ...tailGroups]
}

function isBlockedHostname(hostname: string): boolean {
  const normalized = hostname.replace(/\.$/, '').toLowerCase()
  return blockedHostnames.has(normalized) || normalized.endsWith('.localhost')
}

/**
 * True when an IP address must not be used as a webhook destination.
 * Unknown or malformed addresses fail closed.
 */
export function isProhibitedAddress(address: string): boolean {
  let candidate = address
  if (candidate.startsWith('[') && candidate.endsWith(']')) {
    candidate = candidate.slice(1, -1)
  }

  const normalized = normalizeAddress(candidate)
  if (!normalized) {
    return true
  }

  if (normalized.family === 4) {
    return blockedIpv4.check(normalized.address, 'ipv4')
  }

  const groups = parseIpv6Groups(normalized.address)
  if (!groups) {
    return true
  }

  // IPv4-mapped addresses (::ffff:a.b.c.d) must be checked as IPv4.
  if (
    groups[0] === 0 &&
    groups[1] === 0 &&
    groups[2] === 0 &&
    groups[3] === 0 &&
    groups[4] === 0 &&
    groups[5] === 0xffff
  ) {
    const ipv4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
    return blockedIpv4.check(ipv4, 'ipv4')
  }

  return blockedIpv6.check(normalized.address, 'ipv6')
}

const defaultAddressResolver: AddressResolver = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true, verbatim: true })
  return results.map((result) => ({
    address: result.address,
    family: result.family as IpFamily,
  }))
}

/**
 * Validates that a webhook destination is safe to deliver to.
 *
 * - Only HTTP(S) URLs without embedded credentials are allowed.
 * - IP literals are checked directly; hostnames are resolved and every
 *   returned address must be public (fail closed on DNS errors or empty
 *   answers).
 * - The returned `addresses` are the exact addresses the caller must connect
 *   to. `createPinnedLookup` turns them into a Node lookup function so the
 *   connection cannot be redirected to an unvalidated address (DNS rebinding).
 */
export async function validateWebhookUrl(
  rawUrl: string,
  options: ValidateWebhookUrlOptions = {},
): Promise<ValidatedWebhookUrl> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    throw new SsrfError('INVALID_DESTINATION', 'Destination URL is not valid')
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new SsrfError('INVALID_DESTINATION', 'Destination URL must use HTTP or HTTPS')
  }

  if (options.requireHttps && url.protocol !== 'https:') {
    throw new SsrfError('HTTPS_REQUIRED', 'Destination URL must use HTTPS')
  }

  if (url.username !== '' || url.password !== '') {
    throw new SsrfError('INVALID_DESTINATION', 'Destination URL must not contain credentials')
  }

  const hostname = url.hostname.replace(/^\[/, '').replace(/\]$/, '')
  if (hostname === '' || isBlockedHostname(hostname)) {
    throw new SsrfError('INVALID_DESTINATION', 'Destination URL is not allowed')
  }

  const literalFamily = isIP(hostname)
  if (literalFamily !== 0) {
    if (isProhibitedAddress(hostname)) {
      throw new SsrfError('INVALID_DESTINATION', 'Destination URL is not allowed')
    }
    return {
      url,
      addresses: [{ address: hostname.toLowerCase(), family: literalFamily as IpFamily }],
    }
  }

  const lookup = options.lookup ?? defaultAddressResolver
  let resolved: ResolvedAddress[]
  try {
    resolved = await lookup(hostname)
  } catch {
    throw new SsrfError('INVALID_DESTINATION', 'Destination host could not be resolved')
  }

  if (resolved.length === 0) {
    throw new SsrfError('INVALID_DESTINATION', 'Destination host could not be resolved')
  }

  const addresses = resolved.map((entry) => normalizeAddress(entry.address))
  if (addresses.some((entry) => entry === null)) {
    throw new SsrfError('INVALID_DESTINATION', 'Destination URL is not allowed')
  }

  for (const entry of addresses as ResolvedAddress[]) {
    if (isProhibitedAddress(entry.address)) {
      throw new SsrfError('INVALID_DESTINATION', 'Destination URL is not allowed')
    }
  }

  return { url, addresses: addresses as ResolvedAddress[] }
}

/**
 * Builds a Node `lookup` function that only returns addresses approved by
 * `validateWebhookUrl`. Intended for outbound request options (`lookup`) so a
 * second DNS resolution cannot substitute a different destination.
 */
export function createPinnedLookup(addresses: ResolvedAddress[]): PinnedLookup {
  if (addresses.length === 0) {
    throw new Error('createPinnedLookup requires at least one validated address')
  }

  return (_hostname, options, callback) => {
    if (options?.all) {
      callback(
        null,
        addresses.map((entry) => ({ address: entry.address, family: entry.family })),
      )
      return
    }

    const requestedFamily = options?.family
    const match =
      requestedFamily === 4 || requestedFamily === 6
        ? addresses.find((entry) => entry.family === requestedFamily) ?? addresses[0]
        : addresses[0]

    callback(null, match.address, match.family)
  }
}
