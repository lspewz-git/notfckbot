@echo off
echo Starting NotFckBot via Docker Compose...
docker-compose up -d --build
echo.
echo Bot and Database are starting. Use logs.bat to see the progress.
pause
