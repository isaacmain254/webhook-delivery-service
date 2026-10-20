import { z } from 'zod'

/** Shared UUID validation for event and delivery detail routes. */
export const resourceIdParamsSchema = z.object({
  params: z.object({
    id: z.uuid(),
  }),
})
