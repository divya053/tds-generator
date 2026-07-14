@echo off
echo Building React frontend...
set "PORT=4173"
set "BASE_PATH=/"
pnpm --filter @workspace/spec-extractor run build
echo.
echo Build complete!
pause
