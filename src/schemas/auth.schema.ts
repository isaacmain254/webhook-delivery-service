import { z } from 'zod'

export const apiKeySchema = z.string().length(64).regex(/^[a-f0-9]{64}$/)
