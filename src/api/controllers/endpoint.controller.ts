import type { EndpointStatus } from '../../generated/prisma/enums.js'
import { NotFoundError } from '../../lib/errors.js'
import {
  createEndpointForUser,
  deleteEndpointForUser,
  getEndpointForUser,
  listEndpointsForUser,
  replaceEndpointSubscriptions,
  updateEndpointForUser,
} from '../../services/endpoint.service.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { authenticatedUserId, routeParam } from './helpers.js'

export const createEndpoint = asyncHandler(async (req, res) => {
  const { url, events } = req.body as { url: string; events?: string[] }
  const endpoint = await createEndpointForUser(authenticatedUserId(req), { url, events })
  res.status(201).json(endpoint)
})

export const listEndpoints = asyncHandler(async (req, res) => {
  const endpoints = await listEndpointsForUser(authenticatedUserId(req))
  res.json(endpoints)
})

export const getEndpoint = asyncHandler(async (req, res) => {
  const endpoint = await getEndpointForUser(authenticatedUserId(req), routeParam(req, 'id'))
  if (!endpoint) {
    throw new NotFoundError('Endpoint not found')
  }
  res.json(endpoint)
})

export const updateEndpoint = asyncHandler(async (req, res) => {
  const patch = req.body as { url?: string; status?: EndpointStatus }
  const endpoint = await updateEndpointForUser(
    authenticatedUserId(req),
    routeParam(req, 'id'),
    patch,
  )
  if (!endpoint) {
    throw new NotFoundError('Endpoint not found')
  }
  res.json(endpoint)
})

export const deleteEndpoint = asyncHandler(async (req, res) => {
  const deleted = await deleteEndpointForUser(authenticatedUserId(req), routeParam(req, 'id'))
  if (!deleted) {
    throw new NotFoundError('Endpoint not found')
  }
  res.status(204).end()
})

export const replaceSubscriptions = asyncHandler(async (req, res) => {
  const { events } = req.body as { events: string[] }
  const endpoint = await replaceEndpointSubscriptions(
    authenticatedUserId(req),
    routeParam(req, 'id'),
    events,
  )
  if (!endpoint) {
    throw new NotFoundError('Endpoint not found')
  }
  res.json(endpoint)
})
