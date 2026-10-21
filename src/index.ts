import config from './config.js'
import prisma from './db.js'
import { closeHealthRedis } from './lib/health-redis.js'
import { logger } from './lib/logger.js'
import { createApp } from './app.js'

const app = createApp()

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'API server listening')
})

let shuttingDown = false

/**
 * Closes the listener, stops accepting new connections, then closes the
 * health-Redis singleton and the shared Prisma connection. Repeat signals exit
 * immediately so an operator can force-kill a wedged process.
 */
async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    logger.error(`Received ${signal} during shutdown; exiting immediately`)
    process.exit(1)
  }

  shuttingDown = true
  logger.info({ signal }, 'Shutting down API server')

  try {
    await new Promise<void>((resolve, reject) => {
      server.closeIdleConnections()

      const timeout = setTimeout(() => {
        reject(new Error('Timed out while closing the HTTP server'))
      }, 30_000)
      timeout.unref()

      server.close((error) => {
        clearTimeout(timeout)
        if (error) {
          reject(error)
          return
        }
        resolve()
      })
    }).catch(() => {
      // A hung connection should not be able to prevent the process stop.
      server.closeAllConnections()
    })

    await prisma.$disconnect()
    await closeHealthRedis()

    logger.info('API shutdown complete')
    process.exit(0)
  } catch (error) {
    logger.error({ error }, 'Failed to shut down the API cleanly')
    process.exit(1)
  }
}

process.on('SIGINT', () => {
  void shutdown('SIGINT')
})
process.on('SIGTERM', () => {
  void shutdown('SIGTERM')
})
