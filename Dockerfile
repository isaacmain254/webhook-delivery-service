
FROM node:24-alpine AS build

RUN apk add --no-cache openssl curl

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN DATABASE_URL=postgresql://build:build@localhost:5432/build npm run build

FROM node:24-alpine AS runtime

RUN apk add --no-cache openssl

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/prisma ./prisma
COPY --from=build --chown=node:node /app/prisma7.config.ts ./

USER node

EXPOSE 5000
# Worker health server (WORKER_HEALTH_PORT); binds only when the worker runs.
EXPOSE 5001

CMD ["node", "dist/index.js"]
