# Data 1-1 on any container host (Railway, Render, Fly.io, a VPS).
#   docker build -t data-1-1 .
#   docker run -p 8787:8787 --env-file .env data-1-1
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8787
COPY --from=build /app /app
EXPOSE 8787
# Applies the schema (idempotent), then serves dashboard + API + tracker.
CMD ["sh", "-c", "node scripts/migrate.mjs && node server.js"]
