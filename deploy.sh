#!/usr/bin/env bash
#
# One-command production deploy for the IKIO TDS Generator.
#
#   sudo bash /home/ikiousa/app/deploy.sh
#
# Why this script exists: nginx serves the STATIC frontend bundle straight from
# artifacts/spec-extractor/dist/public — so `pm2 restart` alone NEVER updates the UI.
# The frontend must be rebuilt (with the correct BASE_PATH) on every deploy, and the
# whole thing must run as the app user (git + pm2 both live under `ikiousa`, not root).
# This script does all of that in the right order so nothing can be skipped.
#
set -euo pipefail

APP_DIR="${APP_DIR:-/home/ikiousa/app}"
APP_USER="${APP_USER:-ikiousa}"
# Subpath the app is hosted under. Bakes the asset paths + router base + /api prefix
# into the frontend build. For root hosting instead, run with BASE_PATH=/ .
BASE_PATH="${BASE_PATH:-/ikio-tds-generator/}"

# If launched as root, hand the tree back to the app user (root's git/build changed owners)
# and re-run this same script AS that user so git + pm2 see their own state.
if [ "$(id -u)" = "0" ]; then
  echo "==> chown $APP_DIR -> $APP_USER"
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR"
  exec sudo -iu "$APP_USER" env BASE_PATH="$BASE_PATH" bash "$APP_DIR/deploy.sh"
fi

cd "$APP_DIR"

echo "==> git pull origin main"
git pull origin main

echo "==> build api-server (Node)"
node artifacts/api-server/build.mjs

echo "==> build frontend  (BASE_PATH=$BASE_PATH)"
if command -v pnpm >/dev/null 2>&1; then
  BASE_PATH="$BASE_PATH" pnpm --filter @workspace/spec-extractor run build
else
  ( cd artifacts/spec-extractor && BASE_PATH="$BASE_PATH" npx vite build --config vite.config.ts )
fi

echo "==> restart backends (pm2)"
pm2 restart tds-flask tds-api
pm2 save

echo
pm2 list
echo
echo "==> DONE. Served frontend bundle now:"
ls -1 artifacts/spec-extractor/dist/public/assets/index-*.js 2>/dev/null | sed 's#.*/##' || true
echo "Hard-reload https://ikiousa.tech/ikio-tds-generator/ (Ctrl+Shift+R) and confirm the JS filename above matches the page source."
