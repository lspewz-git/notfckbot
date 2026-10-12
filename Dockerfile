FROM node:22-slim

WORKDIR /app

# Production dependencies only: the tests, linters and type checker stay out of the image.
# Waiting for the database is the healthcheck's job in docker-compose.yml.
COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

CMD ["node", "src/index.js"]
