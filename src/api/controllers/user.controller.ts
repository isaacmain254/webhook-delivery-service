import { generateApiKey, hashApiKey } from '../../lib/crypto.js'
import config from '../../config.js'
import { ConflictError } from '../../lib/errors.js'
import { isUniqueConstraintError } from '../../lib/prisma-errors.js'
import { createUser as persistUser } from '../../services/user.service.js'
import { asyncHandler } from '../middleware/async-handler.js'

export const createUser = asyncHandler(async (req, res) => {
  const { username } = req.body as { username: string }
  const apiKey = generateApiKey()
  const apiKeyHash = hashApiKey(apiKey, config.API_KEY_HASH_SECRET)

  try {
    const user = await persistUser(username, apiKeyHash)
    res.status(201).json({ ...user, apiKey })
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      throw new ConflictError('USERNAME_TAKEN', 'Username is already registered')
    }
    throw error
  }
})
