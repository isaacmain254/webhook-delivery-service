import express from 'express';
import 'dotenv/config'
import endpointRoutes from './routes.js'


const app = express();
const port = process.env.PORT || 5000;

app.use(express.json());

app.use("/v1",  endpointRoutes)

app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});   