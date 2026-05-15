# HomeTracker

Local-first dashboard for tracking home prices over time. Fetches property data
from Realtor.com via [HomeHarvest](https://github.com/Bunsly/HomeHarvest)
server-side and stores every fetch as an append-only snapshot in SQLite.

## Stack

- **Backend**: FastAPI + sqlite3 (stdlib), HomeHarvest for scraping.
- **Frontend**: React (via UMD + Babel-standalone) served as static files by the
  backend. No build step.
- **Storage**: `data/app.db` (SQLite, WAL mode). Auto-created on first run.

## Run locally

```bash
./run.sh
# or:
.venv312/bin/python -m uvicorn backend.app.main:app --reload --port 5173
```

Then open <http://127.0.0.1:5173>.

## API

| Method | Path                                  | Purpose                                |
|-------:|---------------------------------------|----------------------------------------|
| GET    | `/api/properties`                     | List properties + latest snapshot each |
| GET    | `/api/properties/{id}`                | Single property + full snapshot history|
| POST   | `/api/properties`                     | Add a property (returns match status)  |
| POST   | `/api/properties/{id}/refresh`        | Append a new snapshot                  |
| POST   | `/api/properties/refresh-all`         | Append snapshots for every property    |

`POST /api/properties` returns one of:
`matched`, `candidate_mismatch`, `no_candidates`, `error`. A
`candidate_mismatch` requires a second call with `confirm_mismatch: true` to
save.

## Data model

- `properties` — one row per tracked address.
- `snapshots` — append-only history; new rows on every fetch/refresh. Holds the
  normalized AVM, list/sale prices, property facts, and the full raw HomeHarvest
  JSON for debugging.

AVM normalization picks the "best" current estimate from either of the two
shapes HomeHarvest returns: `raw["current_estimates"]` (flat snake_case) or
`raw["estimates"]["currentValues"]` (nested camelCase).

## Scheduled refreshes

Not wired up yet — v1 ships manual refresh only (per-property and
"Refresh all" on the dashboard). The intended cadence is twice per month; the
endpoint `POST /api/properties/refresh-all` is the obvious hook for a cron or
launchd job later.

## Auth

None. Local-only for v1. The frontend talks to the backend over plain HTTP,
and the backend has no user model — easy to bolt a session layer on top later
without disturbing storage.
