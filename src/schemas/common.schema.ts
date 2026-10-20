import { z } from 'zod'

/** Resource routes do not accept query parameters yet. */
export const emptyQuerySchema = z.object({}).strict()

export const uuidParamsSchema = z.object({
  id: z.uuid(),
})

export const resourceIdParamsSchema = z.object({
  params: uuidParamsSchema,
  query: emptyQuerySchema,
})
