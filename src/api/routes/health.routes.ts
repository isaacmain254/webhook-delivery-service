import { Router, type Request, type Response } from 'express'

const healthRouter = Router()

// GET /v1/health
healthRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 200, message: 'Healthy...' })
})

export default healthRouter
