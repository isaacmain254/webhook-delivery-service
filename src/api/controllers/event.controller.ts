import type { EventType } from '../../lib/events.js'
import { ConflictError, NotFoundError } from '../../lib/errors.js'
import { ingestEvent } from '../../services/event.service.js'
import {
  getEventDetailForUser,
  listEventDeliveriesForUser,
} from '../../services/delivery-inspection.service.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { authenticatedUserId, routeParam } from './helpers.js'

interface CreateEventBody {
  idempotencyKey: string
  eventType: EventType
  payload: Record<string, unknown>
}

export const createEvent = asyncHandler(async (req, res) => {
  const body = req.body as CreateEventBody
  const result = await ingestEvent(authenticatedUserId(req), body)

  if (result.outcome === 'conflict') {
    throw new ConflictError(
      'IDEMPOTENCY_KEY_REUSED',
      'Idempotency key was already used for a different payload',
    )
  }

  const responseBody = {
    ...result.event,
    replayed: result.outcome === 'replayed',
  }

  if (result.outcome === 'replayed') {
    res.setHeader('X-Idempotency-Replay', 'true')
    res.status(200).json(responseBody)
    return
  }

  res.status(202).json(responseBody)
})

export const getEvent = asyncHandler(async (req, res) => {
  const event = await getEventDetailForUser(
    authenticatedUserId(req),
    routeParam(req, 'id'),
  )

  if (!event) {
    throw new NotFoundError('Event not found')
  }

  res.json(event)
})

export const listEventDeliveries = asyncHandler(async (req, res) => {
  const deliveries = await listEventDeliveriesForUser(
    authenticatedUserId(req),
    routeParam(req, 'id'),
  )

  if (!deliveries) {
    throw new NotFoundError('Event not found')
  }

  res.json(deliveries)
})
