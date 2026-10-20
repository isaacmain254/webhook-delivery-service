import express, { type Express } from 'express'
import router from '../../src/api/routes/index.js'
import { errorHandler } from '../../src/api/middleware/error-handler.js'
import config from '../../src/config.js'

/**
 * Builds an app for Supertest that mirrors src/index.ts without binding a port.
 */
export function createTestApp(): Express {
  const app = express()
  app.use(express.json({ limit: config.JSON_BODY_LIMIT_BYTES }))
  app.use('/v1', router)
  app.use(errorHandler)
  return app
}
