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

REM Check pnpm
where pnpm >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] pnpm is not installed.
    echo Install with: npm install -g pnpm
    pause & exit /b 1
)

REM Install workspace Node deps if needed
if not exist "node_modules" (
    echo [SETUP] Installing workspace Node.js packages with pnpm...
    pnpm install
    echo Done.
)

REM Install Python Flask packages if needed
echo [SETUP] Checking Python packages...
pip install -r flask-backend\requirements.txt -q

echo.
echo [START] Launching all services...
echo.

REM Start Flask backend
start "Flask Backend [port 5005]" cmd /k "set \"FLASK_PORT=5005\" && set \"OLLAMA_MODEL=qwen2.5:7b\" && set \"OLLAMA_TIMEOUT_SECONDS=900\" && python flask-backend\app.py"
timeout /t 3 /nobreak >nul

REM Start Node API server
start "Node API [port 8787]" cmd /k "set \"PORT=8787\" && set \"FLASK_URL=http://localhost:5005\" && pnpm --filter @workspace/api-server run dev"
timeout /t 2 /nobreak >nul

REM Start React frontend
start "React Frontend [port 4173]" cmd /k "set \"PORT=4173\" && set \"API_PORT=8787\" && pnpm --filter @workspace/spec-extractor run dev"
timeout /t 2 /nobreak >nul

REM Open browser after services are up
start http://localhost:4173

echo.
echo ========================================
echo  App is running!
echo  Frontend: http://localhost:4173
echo  API:      http://localhost:8787/api/healthz
echo  Flask:    http://localhost:5005/health
echo ========================================
echo.
echo  Keep this window open. Close the
echo  other terminal windows to stop.
echo.
pause
