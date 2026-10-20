import express, { type Express } from 'express'
import apiRoutes from './api/routes/index.js'
import docsRoutes from './api/routes/docs.routes.js'
import { errorHandler } from './api/middleware/error-handler.js'
import { notFoundHandler } from './api/middleware/not-found-handler.js'
import config from './config.js'

/** Builds the HTTP application without binding a port. */
export function createApp(): Express {
  const app = express()

  app.use(docsRoutes)
  app.use(express.json({ limit: config.JSON_BODY_LIMIT_BYTES }))
  app.use('/v1', apiRoutes)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
