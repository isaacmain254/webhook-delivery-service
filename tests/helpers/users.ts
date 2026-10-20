import type { Express } from 'express'
import supertest from 'supertest'

export interface TestUser {
  id: string
  username: string
  apiKey: string
}

let counter = 0

/** Unique across parallel test files and repeated runs in the same database. */
export function uniqueUsername(prefix = 'test-user'): string {
  counter += 1
  return `${prefix}-${Date.now().toString(36)}-${counter.toString(36)}`
}

export async function registerUser(
  app: Express,
  username: string = uniqueUsername(),
): Promise<TestUser> {
  const response = await supertest(app).post('/v1/users').send({ username })

  if (response.status !== 201) {
    throw new Error(
      `Failed to register test user (status ${response.status}): ${JSON.stringify(response.body)}`,
    )
  }

  return response.body as TestUser
}
