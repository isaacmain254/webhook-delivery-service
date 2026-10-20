import type { Request } from 'express'

/** User set by the authenticateApiKey middleware. Throws if the route is misconfigured. */
export function authenticatedUserId(req: Request): string {
  if (!req.user) {
    throw new Error('Route requires the authenticateApiKey middleware')
  }
  return req.user.id
}

/** Returns a validated route parameter as a string. */
export function routeParam(req: Request, name: string): string {
  const value = req.params[name]
  if (typeof value !== 'string') {
    throw new Error(`Route parameter "${name}" was not validated`)
  }
  return value
}
