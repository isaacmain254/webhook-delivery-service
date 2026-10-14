import express from 'express';
import endpointRoutes from './routes.js'
import config from './config.js'


const app = express();

app.use(express.json());

app.use("/v1",  endpointRoutes)

app.listen(config.PORT, () => {
  console.log(`Server is running on http://localhost:${config.PORT}`);
});   
