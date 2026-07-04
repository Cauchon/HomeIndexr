#!/usr/bin/env bash
# Local dev: TanStack Start + Vite (one Node process serves API + dashboard) on :5173.
set -euo pipefail
cd "$(dirname "$0")"

# Convenience wrapper around `npm run dev`. PORT overrides the port; HOST=0.0.0.0
# exposes the app to other devices (e.g. an iPhone over Tailscale): HOST=0.0.0.0 ./run.sh
PORT="${PORT:-5173}"
HOST="${HOST:-localhost}"

if [ ! -d node_modules ]; then
  npm install
fi

exec npx vite dev --port "$PORT" --host "$HOST"
