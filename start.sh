#!/bin/bash

echo "Starting notfckbot..."
docker compose up -d --build -V
echo "Bot started successfully!"
echo "To view logs, run: docker compose logs -f app"
