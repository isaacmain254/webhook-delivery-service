import { ConflictError, NotFoundError } from '../../lib/errors.js'
import {
  getDeliveryDetailForUser,
  listDeliveryAttemptsForUser,
} from '../../services/delivery-inspection.service.js'
import { replayDeliveryForUser } from '../../services/delivery-replay.service.js'
import { asyncHandler } from '../middleware/async-handler.js'
import { authenticatedUserId, routeParam } from './helpers.js'

export const getDelivery = asyncHandler(async (req, res) => {
  const delivery = await getDeliveryDetailForUser(
    authenticatedUserId(req),
    routeParam(req, 'id'),
  )

  if (!delivery) {
    throw new NotFoundError('Delivery not found')
  }

  res.json(delivery)
})

export const listDeliveryAttempts = asyncHandler(async (req, res) => {
  const attempts = await listDeliveryAttemptsForUser(
    authenticatedUserId(req),
    routeParam(req, 'id'),
  )

  if (!attempts) {
    throw new NotFoundError('Delivery not found')
  }

  res.json(attempts)
})

export const replayDelivery = asyncHandler(async (req, res) => {
  const result = await replayDeliveryForUser(
    authenticatedUserId(req),
    routeParam(req, 'id'),
  )

  if (result.outcome === 'not_found') {
    throw new NotFoundError('Delivery not found')
  }

  if (result.outcome === 'conflict') {
    throw new ConflictError(
      'DELIVERY_NOT_REPLAYABLE',
      'Only FAILED and SUCCEEDED deliveries can be replayed',
      [{ path: 'status', message: `Delivery status is ${result.status}` }],
    )
  }

  res.status(202).json(result.delivery)
})
