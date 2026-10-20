import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Runs in each test worker before test files (and therefore before src/config.ts
// and src/db.ts are imported). The global setup created the disposable
// database and left its connection string in tests/.tmp.
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
