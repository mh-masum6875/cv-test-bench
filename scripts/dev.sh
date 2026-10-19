#!/bin/bash
# Start the dashboard:  ./scripts/dev.sh   (then open http://127.0.0.1:8000)
cd "$(dirname "$0")/.."
[ -d .venv ] && . .venv/bin/activate
exec python -m uvicorn app.main:app --host "${HOST:-127.0.0.1}" --port "${PORT:-8000}"
