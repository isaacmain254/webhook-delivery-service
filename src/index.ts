import express from 'express';
import apiRoutes from './api/routes/index.js'
import config from './config.js'


const app = express();

app.use(express.json());

app.use("/v1", apiRoutes)

app.listen(config.PORT, () => {
  console.log(`Server is running on http://localhost:${config.PORT}`);
});   
