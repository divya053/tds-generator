@echo off
echo ========================================
echo  Lighting Spec Extractor - Quick Start
echo ========================================
echo.

REM Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed.
    echo Download from: https://nodejs.org  (LTS version)
    pause & exit /b 1
)

REM Check Python
where python >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python is not installed.
    echo Download from: https://python.org
    pause & exit /b 1
)

REM Install Node deps for local-server if needed
if not exist "local-server\node_modules" (
    echo [SETUP] Installing API server Node.js packages...
    cd local-server
    npm install
    cd ..
    echo Done.
)

REM Install Python Flask packages if needed
echo [SETUP] Checking Python packages...
pip install flask flask-cors pdfplumber requests -q

echo.
echo [START] Launching all services...
echo.

REM Start Flask backend
start "Flask Backend [port 5001]" cmd /k "python flask-backend\app.py"
timeout /t 3 /nobreak >nul

REM Start combined API + Frontend server
start "App Server [port 3000]" cmd /k "cd local-server && node server.js"
timeout /t 2 /nobreak >nul

REM Open browser
start http://localhost:3000

echo.
echo ========================================
echo  App is running!
echo  Open: http://localhost:3000
echo ========================================
echo.
echo  Keep this window open. Close the
echo  other terminal windows to stop.
echo.
pause
