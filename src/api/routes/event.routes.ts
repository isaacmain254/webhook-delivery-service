import { Router } from 'express'
import {
  createEvent,
  getEvent,
  listEventDeliveries,
} from '../controllers/event.controller.js'
import { validateRequest } from '../middleware/validate-request.js'
import { resourceIdParamsSchema } from '../../schemas/delivery.schema.js'
import { createEventRequestSchema } from '../../schemas/event.schema.js'

const eventRouter = Router()

// POST /v1/events   Submit an event for delivery
eventRouter.post('/events', validateRequest(createEventRequestSchema), createEvent)

// GET /v1/events/:id   Inspect an event
eventRouter.get('/events/:id', validateRequest(resourceIdParamsSchema), getEvent)

// GET /v1/events/:id/deliveries   List an event's deliveries
eventRouter.get(
  '/events/:id/deliveries',
  validateRequest(resourceIdParamsSchema),
  listEventDeliveries,
)

export default eventRouter
