import type { RequestHandler } from 'express'
import { generateApiKey, hashApiKey } from './lib/crypto.js'
import config from './config.js'
import { createUser as persistUser } from './services.js'

function isUniqueConstraintError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'P2002'
  )
}

export const createUser: RequestHandler = async (req, res, next) => {
  const apiKey = generateApiKey()
  const apiKeyHash = hashApiKey(apiKey, config.API_KEY_HASH_SECRET)

  try {
    const user = await persistUser(req.body.username, apiKeyHash)
    res.status(201).json({ ...user, apiKey })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      res.status(409).json({
        error: { code: 'USERNAME_TAKEN', message: 'Username is already registered' },
      })
      return
    }
    next(error)
  }
}
