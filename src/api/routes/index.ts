import { Router, type Request, type Response } from 'express'
import { authenticateApiKey } from '../middleware/authenticate-api-key.js'
import healthRouter from './health.routes.js'
import userRouter from './user.routes.js'
import endpointRouter from './endpoint.routes.js'
import eventRouter from './event.routes.js'

const router = Router()

const notImplemented = (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' })
}

// Public routes.
router.use(healthRouter)
router.use(userRouter)

// All resource routes below this point require a valid user API key.
router.use(authenticateApiKey)
router.use(endpointRouter)
router.use(eventRouter)

// GET	/v1/events/:id	Inspect an event and its deliveries
router.get('/events/:id', notImplemented)

// GET	/v1/deliveries/:id	Inspect delivery status and attempts
router.get('/deliveries/:id', notImplemented)

// POST	/v1/deliveries/:id/replay	Request a replay of a failed delivery
router.post('/deliveries/:id/replay', notImplemented)

export default router
