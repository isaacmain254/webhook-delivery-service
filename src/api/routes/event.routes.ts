import { Router } from 'express'
import { createEvent } from '../controllers/event.controller.js'
import { validateRequest } from '../middleware/validate-request.js'
import { createEventRequestSchema } from '../../schemas/event.schema.js'

const eventRouter = Router()

// POST /v1/events   Submit an event for delivery
eventRouter.post('/events', validateRequest(createEventRequestSchema), createEvent)

export default eventRouter
