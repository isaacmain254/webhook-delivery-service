import config from './config.js'
import { createApp } from './app.js'

const app = createApp()

app.listen(config.PORT, () => {
  console.log(`Server is running on http://localhost:${config.PORT}`)
})
