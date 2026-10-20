import { Router } from 'express'
import { authenticateApiKey } from '../middleware/authenticate-api-key.js'
import healthRouter from './health.routes.js'
import userRouter from './user.routes.js'
import endpointRouter from './endpoint.routes.js'
import eventRouter from './event.routes.js'
import deliveryRouter from './delivery.routes.js'

const router = Router()

// Public routes.
router.use(healthRouter)
router.use(userRouter)

// All resource routes below this point require a valid user API key.
router.use(authenticateApiKey)
router.use(endpointRouter)
router.use(eventRouter)
router.use(deliveryRouter)

export default router
