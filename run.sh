#!/usr/bin/env bash
# Local dev: backend (FastAPI + SQLite) on :5173, also serves the frontend.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-.venv312/bin/python}"
if [ ! -x "$PYTHON" ]; then
  PYTHON="$(command -v python3)"
fi

PORT="${PORT:-5173}"
exec "$PYTHON" -m uvicorn backend.app.main:app --reload --port "$PORT" --host 127.0.0.1
