import type { RequestHandler } from 'express'
import prisma from '../../db.js'
import config from '../../config.js'
import { hashApiKey } from '../../lib/crypto.js'

function unauthorized(res: Parameters<RequestHandler>[1]): void {
  res.status(401).json({
    error: { code: 'UNAUTHORIZED', message: 'A valid X-API-Key header is required' },
  })
}

export const authenticateApiKey: RequestHandler = async (req, res, next) => {
  const apiKey = req.get('X-API-Key')
  if (!apiKey || !/^[a-f0-9]{64}$/.test(apiKey)) {
    unauthorized(res)
    return
  }

  try {
    const user = await prisma.user.findFirst({
      where: { apiKeyHash: hashApiKey(apiKey, config.API_KEY_HASH_SECRET) },
      select: { id: true, username: true },
    })

    if (!user) {
      unauthorized(res)
      return
    }

    req.user = user
    next()
  } catch (error) {
    next(error)
  }
}
