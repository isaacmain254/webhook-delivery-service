import { Router } from 'express'
import {
  getDelivery,
  listDeliveryAttempts,
  replayDelivery,
} from '../controllers/delivery.controller.js'
import { validateRequest } from '../middleware/validate-request.js'
import { resourceIdParamsSchema } from '../../schemas/delivery.schema.js'

const deliveryRouter = Router()

// GET /v1/deliveries/:id   Inspect delivery status
deliveryRouter.get('/deliveries/:id', validateRequest(resourceIdParamsSchema), getDelivery)

// GET /v1/deliveries/:id/attempts   Inspect delivery attempt history
deliveryRouter.get(
  '/deliveries/:id/attempts',
  validateRequest(resourceIdParamsSchema),
  listDeliveryAttempts,
)

// POST /v1/deliveries/:id/replay   Schedule a new delivery cycle
deliveryRouter.post(
  '/deliveries/:id/replay',
  validateRequest(resourceIdParamsSchema),
  replayDelivery,
)

export default deliveryRouter
