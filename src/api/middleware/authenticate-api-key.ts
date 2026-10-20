import type { RequestHandler } from 'express'
import prisma from '../../db.js'
import config from '../../config.js'
import { hashApiKey } from '../../lib/crypto.js'
import { AuthError } from '../../lib/errors.js'
import { apiKeySchema } from '../../schemas/auth.schema.js'
import { asyncHandler } from './async-handler.js'

export const authenticateApiKey: RequestHandler = asyncHandler(
  async (req, _res, next) => {
    const apiKey = apiKeySchema.safeParse(req.get('X-API-Key'))
    if (!apiKey.success) {
      throw new AuthError()
    }

    const user = await prisma.user.findFirst({
      where: { apiKeyHash: hashApiKey(apiKey.data, config.API_KEY_HASH_SECRET) },
      select: { id: true, username: true },
    })

    if (!user) {
      throw new AuthError()
    }

    req.user = user
    next()
  },
)
