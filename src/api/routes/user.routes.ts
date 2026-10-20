import { Router } from 'express'
import { createUser } from '../controllers/user.controller.js'
import { validateRequest } from '../middleware/validate-request.js'
import { createUserRequestSchema } from '../../schemas/user.schema.js'

const userRouter = Router()

// POST /v1/users   Create a user
userRouter.post('/users', validateRequest(createUserRequestSchema), createUser)

export default userRouter
