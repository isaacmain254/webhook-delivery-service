import type { RequestHandler, Response } from 'express'
import {
  getDeliveryDetailForUser,
  listDeliveryAttemptsForUser,
} from '../../services/delivery-inspection.service.js'
import { replayDeliveryForUser } from '../../services/delivery-replay.service.js'
import { authenticatedUserId, routeParam } from './helpers.js'

function sendDeliveryNotFound(res: Response): void {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Delivery not found' } })
}

export const getDelivery: RequestHandler = async (req, res, next) => {
  try {
    const delivery = await getDeliveryDetailForUser(
      authenticatedUserId(req),
      routeParam(req, 'id'),
    )

    if (!delivery) {
      sendDeliveryNotFound(res)
      return
    }

    res.json(delivery)
  } catch (error) {
    next(error)
  }
}

export const listDeliveryAttempts: RequestHandler = async (req, res, next) => {
  try {
    const attempts = await listDeliveryAttemptsForUser(
      authenticatedUserId(req),
      routeParam(req, 'id'),
    )

    if (!attempts) {
      sendDeliveryNotFound(res)
      return
    }

    res.json(attempts)
  } catch (error) {
    next(error)
  }
}

export const replayDelivery: RequestHandler = async (req, res, next) => {
  try {
    const result = await replayDeliveryForUser(
      authenticatedUserId(req),
      routeParam(req, 'id'),
    )

    if (result.outcome === 'not_found') {
      sendDeliveryNotFound(res)
      return
    }

    if (result.outcome === 'conflict') {
      res.status(409).json({
        error: {
          code: 'DELIVERY_NOT_REPLAYABLE',
          message: 'Only FAILED and SUCCEEDED deliveries can be replayed',
          details: [{ path: 'status', message: `Delivery status is ${result.status}` }],
        },
      })
      return
    }

    res.status(202).json(result.delivery)
  } catch (error) {
    next(error)
  }
}
