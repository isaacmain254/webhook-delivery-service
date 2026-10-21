import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs in each test worker before test files (and therefore before src/config.ts
// and src/db.ts are imported). The global setup created the disposable
// database and left its connection string in tests/.tmp.
//
// Vitest loads .env into process.env before setup files run, so LOG_LEVEL from
// .env would already be present here. Force the test environment explicitly:
// NODE_ENV is always 'test' regardless of .env, and application logs are
// silenced so test output stays clean. To opt back into logs while debugging,
// set TEST_LOG_LEVEL (e.g. TEST_LOG_LEVEL=debug npm test).
process.env.NODE_ENV = 'test'
process.env.LOG_LEVEL = process.env.TEST_LOG_LEVEL ?? 'silent'

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const databaseUrlFile = path.join(testsDir, '.tmp', 'test-database-url')

let testDatabaseUrl: string
try {
  testDatabaseUrl = readFileSync(databaseUrlFile, 'utf8').trim()
} catch {
  throw new Error(
    'The disposable test database is not ready. Vitest global setup must run before test files.',
  )
}

process.env.DATABASE_URL = testDatabaseUrl
