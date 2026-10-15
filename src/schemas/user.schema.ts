import { z } from 'zod'

export const createUserRequestSchema = z.object({
  body: z.object({
    username: z.string().min(3).max(64),
  }),
})
