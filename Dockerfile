# Stage 1: Build
FROM node:20-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY apps/cloud/package.json apps/cloud/
RUN npm ci

COPY apps/cloud/tsconfig.json apps/cloud/
COPY apps/cloud/src apps/cloud/src
RUN npm run build:cloud

# Stage 2: Production
FROM node:20-alpine
WORKDIR /app

COPY package*.json ./
COPY apps/cloud/package.json apps/cloud/
RUN npm ci --omit=dev

COPY --from=builder /app/apps/cloud/dist apps/cloud/dist
COPY apps/cloud/src/db/migrations apps/cloud/dist/db/migrations

ENV NODE_ENV=production
EXPOSE 3000

CMD ["sh", "-c", "node apps/cloud/dist/db/runner.js && node apps/cloud/dist/index.js"]
