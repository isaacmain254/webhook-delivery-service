import "dotenv/config";
import { defineConfig, env } from "prisma/config";
import config from './src/config'


export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: config.databaseUrl
  },
});
