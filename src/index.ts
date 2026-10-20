import express from 'express'
import apiRoutes from './api/routes/index.js'
import { errorHandler } from './api/middleware/error-handler.js'
import config from './config.js'

const app = express()

app.use(express.json({ limit: config.JSON_BODY_LIMIT_BYTES }))
app.use('/v1', apiRoutes)
app.use(errorHandler)

app.listen(config.PORT, () => {
  console.log(`Server is running on http://localhost:${config.PORT}`)
})
