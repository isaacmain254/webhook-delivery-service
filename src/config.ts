import 'dotenv/config'
import { z } from 'zod'

const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(5000),
    DATABASE_URL: z
      .url()
      .refine(
        (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
        'must be a PostgreSQL connection URL',
      ),
    REDIS_URL: z
      .url()
      .refine(
        (value) => value.startsWith('redis://') || value.startsWith('rediss://'),
        'must be a Redis connection URL',
      )
      .default('redis://localhost:6379'),
    API_KEY_HASH_SECRET: z.string().min(32),
    MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().positive().default(5),
    INITIAL_RETRY_DELAY_MS: z.coerce.number().int().positive().default(1000),
    MAX_RETRY_DELAY_MS: z.coerce.number().int().positive().default(3_600_000),
    DELIVERY_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
    MAX_RESPONSE_BODY_BYTES: z.coerce.number().int().positive().default(4_096),
    WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
    WORKER_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(45_000),
    LEASE_DURATION_MS: z.coerce.number().int().positive().default(120_000),
    REQUIRE_HTTPS_DESTINATIONS: z.stringbool().default(true),
    JSON_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    MAX_EVENT_PAYLOAD_BYTES: z.coerce.number().int().positive().default(65_536),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5_000),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(50),
    OUTBOX_LEASE_DURATION_MS: z.coerce.number().int().positive().default(30_000),
    OUTBOX_RECONCILE_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
    OUTBOX_RECONCILE_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  })
  .superRefine((env, context) => {
    if (env.LEASE_DURATION_MS <= env.DELIVERY_TIMEOUT_MS) {
      context.addIssue({
        code: 'custom',
        path: ['LEASE_DURATION_MS'],
        message: 'must be greater than DELIVERY_TIMEOUT_MS',
      })
    }

    if (env.INITIAL_RETRY_DELAY_MS > env.MAX_RETRY_DELAY_MS) {
      context.addIssue({
        code: 'custom',
        path: ['INITIAL_RETRY_DELAY_MS'],
        message: 'must not exceed MAX_RETRY_DELAY_MS',
      })
    }

    if (env.MAX_EVENT_PAYLOAD_BYTES > env.JSON_BODY_LIMIT_BYTES) {
      context.addIssue({
        code: 'custom',
        path: ['MAX_EVENT_PAYLOAD_BYTES'],
        message: 'must not exceed JSON_BODY_LIMIT_BYTES',
      })
    }
  })

export type AppConfig = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(env)

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'environment'}: ${issue.message}`)
      .join('; ')
    throw new Error(`Invalid environment configuration: ${details}`)
  }

  return result.data
}

const config = loadConfig()

export default config
