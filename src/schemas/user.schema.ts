import { z } from 'zod'
import { emptyQuerySchema } from './common.schema.js'

export const createUserRequestSchema = z.object({
  body: z.object({
    username: z.string().min(3).max(64),
  }),
  query: emptyQuerySchema,
})
