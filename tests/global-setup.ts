import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import 'dotenv/config'
import pg from 'pg'

const { Client } = pg

const testsDir = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(testsDir, '..')
const tmpDir = path.join(testsDir, '.tmp')
const databaseUrlFile = path.join(tmpDir, 'test-database-url')
const databasePrefix = 'webhook_service_test_'
const staleDatabaseMaxAgeMs = 60 * 60 * 1000
const npxCommand = process.platform === 'win32' ? 'npx.cmd' : 'npx'

let activeDatabaseName: string | null = null
let adminConnectionString: string | null = null

function parseBaseUrl(): URL {
  const raw = process.env.DATABASE_URL
  if (!raw) {
    throw new Error(
      'DATABASE_URL is required to create the disposable test database. ' +
        'Copy .env.example to .env or export DATABASE_URL.',
    )
  }

  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('DATABASE_URL is not a valid URL')
  }

  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL must be a PostgreSQL connection URL')
  }

  return url
}

function connectionStringFor(base: URL, database: string): string {
  const url = new URL(base.toString())
  url.pathname = `/${database}`
  // Prisma-only parameters such as `schema` are not understood by pg.
  url.search = ''
  return url.toString()
}

async function dropStaleTestDatabases(client: pg.Client): Promise<void> {
  const { rows } = await client.query<{ datname: string }>(
    'SELECT datname FROM pg_database WHERE datname LIKE $1',
    [`${databasePrefix}%`],
  )

  const cutoff = Date.now() - staleDatabaseMaxAgeMs
  for (const row of rows) {
    const match = /_(\d{13})_[0-9a-f]+$/.exec(row.datname)
    if (!match || Number(match[1]) >= cutoff) {
      continue
    }

    try {
      await client.query(`DROP DATABASE "${row.datname}" WITH (FORCE)`)
    } catch {
      // Best effort: a leftover database is harmless and will be retried later.
    }
  }
}

function applyMigrations(databaseUrl: string): void {
  try {
    execFileSync(npxCommand, ['--no-install', 'prisma', 'migrate', 'deploy'], {
      cwd: repoRoot,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: 'pipe',
    })
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim()
    throw new Error(
      `Failed to apply migrations to the test database${stderr ? `: ${stderr}` : ''}`,
    )
  }
}

/**
 * Creates a disposable PostgreSQL database, applies migrations to it, and
 * writes its connection string to tests/.tmp/test-database-url. The Vitest
 * setup file (`tests/setup-env.ts`) reads that file before any application
 * module is imported.
 */
export async function setup(): Promise<void> {
  const base = parseBaseUrl()
  adminConnectionString = connectionStringFor(base, 'postgres')

  const admin = new Client({ connectionString: adminConnectionString })
  try {
    await admin.connect()
  } catch (error) {
    throw new Error(
      'Could not connect to PostgreSQL to create the test database. ' +
        'Start it with `docker compose up -d postgres`. ' +
        `(${(error as Error).message})`,
    )
  }

  try {
    await dropStaleTestDatabases(admin)

    const databaseName = `${databasePrefix}${Date.now()}_${randomBytes(4).toString('hex')}`
    await admin.query(`CREATE DATABASE "${databaseName}"`)
    activeDatabaseName = databaseName

    const testDatabaseUrl = connectionStringFor(base, databaseName)
    applyMigrations(testDatabaseUrl)

    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(databaseUrlFile, testDatabaseUrl)
  } finally {
    await admin.end()
  }
}

/** Drops the test database and removes the temporary connection string. */
export async function teardown(): Promise<void> {
  rmSync(tmpDir, { recursive: true, force: true })

  if (!activeDatabaseName || !adminConnectionString) {
    return
  }

  const databaseName = activeDatabaseName
  activeDatabaseName = null

  const admin = new Client({ connectionString: adminConnectionString })
  try {
    await admin.connect()
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`)
  } catch (error) {
    console.error(`[test-setup] Could not drop ${databaseName}: ${(error as Error).message}`)
  } finally {
    await admin.end().catch(() => {})
  }
}
