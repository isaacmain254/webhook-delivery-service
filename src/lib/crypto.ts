import { createHash, randomBytes } from 'node:crypto'

export function generateApiKey(): string {
  return randomBytes(32).toString('hex')
}

export function hashApiKey(apiKey: string, pepper: string): string {
  return createHash('sha256').update(apiKey + pepper).digest('hex')
}
