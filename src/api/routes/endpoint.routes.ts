import { Router } from 'express'
import {
  createEndpoint,
  deleteEndpoint,
  getEndpoint,
  listEndpoints,
  replaceSubscriptions,
  updateEndpoint,
} from '../controllers/endpoint.controller.js'
import { validateRequest } from '../middleware/validate-request.js'
import {
  createEndpointRequestSchema,
  endpointParamsSchema,
  updateEndpointRequestSchema,
  updateSubscriptionsRequestSchema,
} from '../../schemas/endpoint.schema.js'

const endpointRouter = Router()

// POST /v1/endpoints   Register a webhook endpoint
endpointRouter.post('/endpoints', validateRequest(createEndpointRequestSchema), createEndpoint)

// GET /v1/endpoints   List registered endpoints
endpointRouter.get('/endpoints', listEndpoints)

// GET /v1/endpoints/:id   Get endpoint by Id
endpointRouter.get('/endpoints/:id', validateRequest(endpointParamsSchema), getEndpoint)

// PATCH /v1/endpoints/:id   Update URL or active status
endpointRouter.patch('/endpoints/:id', validateRequest(updateEndpointRequestSchema), updateEndpoint)

// DELETE /v1/endpoints/:id   Remove an endpoint
endpointRouter.delete('/endpoints/:id', validateRequest(endpointParamsSchema), deleteEndpoint)

// PUT /v1/endpoints/:id/subscriptions   Configure subscribed event types
endpointRouter.put(
  '/endpoints/:id/subscriptions',
  validateRequest(updateSubscriptionsRequestSchema),
  replaceSubscriptions,
)

export default endpointRouter
