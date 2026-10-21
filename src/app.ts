import express, { type Express } from 'express'
import { pinoHttp } from 'pino-http'
import { randomUUID } from 'node:crypto'
import apiRoutes from './api/routes/index.js'
import docsRoutes from './api/routes/docs.routes.js'
import { errorHandler } from './api/middleware/error-handler.js'
import { notFoundHandler } from './api/middleware/not-found-handler.js'
import { assignRequestId } from './api/middleware/request-id.js'
import { httpLoggerSerializers, logger } from './lib/logger.js'
import config from './config.js'

/** Builds the HTTP application without binding a port. */
export function createApp(): Express {
  const app = express()

  app.use(assignRequestId)
  app.use(
    pinoHttp({
      logger,
      genReqId: (req, _res) => req.requestId ?? randomUUID(),
      serializers: httpLoggerSerializers,
      autoLogging: {
        // Large static docs assets and per-30s liveness probes pollute logs.
        ignore: (req) =>
          Boolean(
            req.url?.startsWith('/docs/assets') ||
              req.url?.startsWith('/v1/health/live'),
          ),
      },
    }),
  )

  app.use(docsRoutes)
  app.use(express.json({ limit: config.JSON_BODY_LIMIT_BYTES }))
  app.use('/v1', apiRoutes)
  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
