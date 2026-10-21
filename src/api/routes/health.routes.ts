import { Router } from 'express'
import { asyncHandler } from '../middleware/async-handler.js'
import { checkReadiness, livenessState } from '../../services/health.service.js'

const healthRouter = Router()

// GET /v1/health — readiness: reports live dependency connections. Rendered
// with 503 when PostgreSQL or Redis is unreachable so HTTP probes and container
// healthchecks can react to a real outage rather than a dead process only.
healthRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const state = await checkReadiness()
    res.status(state.status === 'ok' ? 200 : 503).json(state)
  }),
)

// GET /v1/health/live — liveness: process is up and serving. Never depends on
// external services, so a dependency outage does not get treated as a crash.
healthRouter.get('/health/live', (_req, res) => {
  res.json(livenessState())
})

export default healthRouter
