import type { AuthenticatedUser } from './auth.js'

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser
      /** Correlation identifier assigned by the request-id middleware. */
      requestId?: string
    }
  }
}

export {}
