import { z } from 'zod'
import { emptyQuerySchema } from './common.schema.js'

export const createUserBodySchema = z
  .object({
    username: z
      .string()
      .min(3)
      .max(64)
      .meta({
        description: 'Unique username for the account',
        example: 'acme-payments',
      }),
  })
  .meta({ id: 'CreateUserBody', description: 'Account registration details' })

export const createUserRequestSchema = z.object({
  body: createUserBodySchema,
  query: emptyQuerySchema,
})
