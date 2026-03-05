@echo off
setlocal
:menu
cls
echo ==========================================
echo       NotFckBot Notification Tester
echo ==========================================
echo 1. Test Regular Episode (Standard)
echo 2. Test Full Season Completion
echo 3. Test First Episode of New Season
echo 4. Test Movie Watchlist Release
echo 5. Exit
echo ==========================================
set /p choice="Select an option (1-5): "

if "%choice%"=="5" goto end
if "%choice%"=="4" goto test_movie
if "%choice%"=="1" set TEST_MODE=episode
if "%choice%"=="2" set TEST_MODE=season
if "%choice%"=="3" set TEST_MODE=first_episode

if "%TEST_MODE%"=="" (
    echo Invalid choice.
    pause
    goto menu
)

set /p FILM_ID="Enter Kinopoisk ID for series (e.g., 464963): "
if "%FILM_ID%"=="" (
    echo ID cannot be empty.
    pause
    goto menu
)

echo.
echo Running test: %TEST_MODE% for ID %FILM_ID%...
node src/test-notifications.js %FILM_ID% %TEST_MODE%

echo.
echo Test completed.
pause
goto menu

:test_movie
echo.
echo === Movie Watchlist Release Test ===
set /p MOVIE_ID="Enter Kinopoisk ID of movie in your Watchlist (e.g., 533447): "
if "%MOVIE_ID%"=="" (
    echo ID cannot be empty.
    pause
    goto menu
)
echo.
echo Simulating digital release notification for movie %MOVIE_ID%...
node src/test-watchlist.js %MOVIE_ID%
echo.
echo Test completed.
pause
goto menu

:end
echo Goodbye!
exit /b
