import express, { type Express } from 'express'
import router from '../../src/api/routes/index.js'

/**
 * Builds an app for Supertest that mirrors src/index.ts without binding a port.
 */
export function createTestApp(): Express {
  const app = express()
  app.use(express.json())
  app.use('/v1', router)
  return app
}
