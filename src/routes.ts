import { Router, type Request, type Response } from 'express'
import { createUser } from './controllers.js'

const router = Router()

const notImplemented = (_req: Request, res: Response) => {
  res.status(501).json({ error: 'Not implemented' })
}

router.get("/health", (req: Request, res: Response) => {
    res.json({status: 200, message: "Healthy..."})
})
// POST /v1/users   Create a user
router.post("/users", createUser)

// POST	/v1/endpoints	Register a webhook endpoint
router.post("/endpoints", notImplemented)

// GET	/v1/endpoints	List registered endpoints
router.get("/endpoints", notImplemented)

// GET /v1/endpoints/:id Get endpoint by Id
router.get("/endpoints/:id", notImplemented)

// PATCH	/v1/endpoints/:id	Update URL or active status
router.patch("/endpoints/:id", notImplemented)

// DELETE	/v1/endpoints/:id	Remove an endpoint
router.delete("/endpoints/:id", notImplemented)

// PUT	/v1/endpoints/:id/subscriptions	Configure subscribed event types
router.put("/endpoints/:id/subscriptions", notImplemented)

// POST	/v1/events	Submit an event for delivery
router.post("/events", notImplemented)

// GET	/v1/events/:id	Inspect an event and its deliveries
router.get("/events/:id", notImplemented)

// GET	/v1/deliveries/:id	Inspect delivery status and attempts
router.get("/deliveries/:id", notImplemented)

// POST	/v1/deliveries/:id/replay	Request a replay of a failed delivery
router.post("/deliveries/:id/replay", notImplemented)

export default router