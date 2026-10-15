#!/bin/sh
cd "$(dirname "$0")"
# install packages the first time, and again whenever package.json changed (e.g. after an update)
if [ ! -d node_modules ] || ! cmp -s package.json node_modules/.tvhub-package.json; then
  npm install --no-audit --no-fund && cp package.json node_modules/.tvhub-package.json
fi
# the exchange library (ccxt) is only needed for REAL crypto orders; signal and paper modes work without it
node system-check.js install || echo "[WARNING] ccxt not installed: signal/paper work, real crypto orders will not (VPN? then run again)."
[ -f .env ] || cp .env.example .env
node server.js
