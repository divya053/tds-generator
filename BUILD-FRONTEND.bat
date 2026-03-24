@echo off
echo Building React frontend...
cd artifacts\spec-extractor
set PORT=3000
set BASE_PATH=/
npx vite build
cd ..\..
echo.
echo Build complete! Restart the App Server window (local-server) to see changes.
pause
