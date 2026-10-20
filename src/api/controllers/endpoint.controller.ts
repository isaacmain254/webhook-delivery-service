import type { RequestHandler, Response } from 'express'
import { SsrfError } from '../../lib/ssrf.js'
import type { EndpointStatus } from '../../generated/prisma/enums.js'
import {
  createEndpointForUser,
  deleteEndpointForUser,
  getEndpointForUser,
  listEndpointsForUser,
  replaceEndpointSubscriptions,
  updateEndpointForUser,
} from '../../services/endpoint.service.js'
import { authenticatedUserId, routeParam } from './helpers.js'

function sendNotFound(res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } })
}

/**
 * Maps SSRF rejections to a client error without exposing internal network
 * details. Returns false when the error is not an SSRF rejection.
 */
function handleSsrfError(res: Response, error: unknown): boolean {
  if (!(error instanceof SsrfError)) {
    return false
  }

  res.status(422).json({ error: { code: error.code, message: error.message } })
  return true
}

export const createEndpoint: RequestHandler = async (req, res, next) => {
  const { url, events } = req.body as { url: string; events?: string[] }

  try {
    const endpoint = await createEndpointForUser(authenticatedUserId(req), { url, events })
    res.status(201).json(endpoint)
  } catch (error) {
    if (!handleSsrfError(res, error)) {
      next(error)
    }
  }
}

export const listEndpoints: RequestHandler = async (req, res, next) => {
  try {
    const endpoints = await listEndpointsForUser(authenticatedUserId(req))
    res.json(endpoints)
  } catch (error) {
    next(error)
  }
}

export const getEndpoint: RequestHandler = async (req, res, next) => {
  try {
    const endpoint = await getEndpointForUser(authenticatedUserId(req), routeParam(req, 'id'))
    if (!endpoint) {
      sendNotFound(res)
      return
    }
    res.json(endpoint)
  } catch (error) {
    next(error)
  }
}

export const updateEndpoint: RequestHandler = async (req, res, next) => {
  const patch = req.body as { url?: string; status?: EndpointStatus }

  try {
    const endpoint = await updateEndpointForUser(
      authenticatedUserId(req),
      routeParam(req, 'id'),
      patch,
    )
    if (!endpoint) {
      sendNotFound(res)
      return
    }
    res.json(endpoint)
  } catch (error) {
    if (!handleSsrfError(res, error)) {
      next(error)
    }
  }
}

export const deleteEndpoint: RequestHandler = async (req, res, next) => {
  try {
    const deleted = await deleteEndpointForUser(authenticatedUserId(req), routeParam(req, 'id'))
    if (!deleted) {
      sendNotFound(res)
      return
    }
    res.status(204).end()
  } catch (error) {
    next(error)
  }
}

export const replaceSubscriptions: RequestHandler = async (req, res, next) => {
  const { events } = req.body as { events: string[] }

  try {
    const endpoint = await replaceEndpointSubscriptions(
      authenticatedUserId(req),
      routeParam(req, 'id'),
      events,
    )
    if (!endpoint) {
      sendNotFound(res)
      return
    }
    res.json(endpoint)
  } catch (error) {
    next(error)
  }
}
