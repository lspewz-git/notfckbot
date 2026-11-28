FROM node:22-slim AS panel
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY admin ./admin
COPY scripts/build-panel.js ./scripts/build-panel.js
RUN npm run build:panel

FROM node:22-slim

WORKDIR /app

# Production dependencies only: the tests, linters and type checker stay out of the image.
# Waiting for the database is the healthcheck's job in docker-compose.yml.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .
COPY --from=panel /app/admin/dist ./admin/dist

CMD ["node", "src/index.js"]
