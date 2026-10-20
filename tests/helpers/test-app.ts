import type { Express } from 'express'
import { createApp } from '../../src/app.js'

/**
 * Builds an app for Supertest using the same middleware, validation, and error
 * handling as the production entry point.
 */
export function createTestApp(): Express {
  return createApp()
}
