# HomeTracker

Local-first dashboard for tracking home prices over time. Fetches property data
from Realtor.com via [HomeHarvest](https://github.com/Bunsly/HomeHarvest)
server-side and stores every fetch as an append-only snapshot in SQLite. The
Property view can also backfill Realtor historical AVMs and sparse market
events so sales, listings, and price changes are not buried in mostly empty
snapshot columns.

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
| GET    | `/api/properties/{id}`                | Property + snapshots + history + events |
| POST   | `/api/properties`                     | Add a property (returns match status)  |
| POST   | `/api/properties/{id}/refresh`        | Append a new snapshot                  |
| POST   | `/api/properties/{id}/backfill`       | Upsert historical AVMs + market events |
| POST   | `/api/properties/refresh-all`         | Append snapshots for every property    |
| POST   | `/api/properties/backfill-all`        | Backfill history/events for all records |

`POST /api/properties` returns one of:
`matched`, `candidate_mismatch`, `no_candidates`, `error`. A
`candidate_mismatch` requires a second call with `confirm_mismatch: true` to
save.

## Data model

- `properties` — one row per tracked address.
- `snapshots` — append-only history; new rows on every fetch/refresh. Holds the
  normalized AVM, list/sale prices, property facts, and the full raw HomeHarvest
  JSON for debugging.
- `historical_estimates` — monthly historical AVM series keyed by property,
  source, and date.
- `property_events` — Realtor market events such as listed, sold, relisted,
  listing removed, and price changed.

AVM normalization picks the "best" current estimate from either of the two
shapes HomeHarvest returns: `raw["current_estimates"]` (flat snake_case) or
`raw["estimates"]["currentValues"]` (nested camelCase).

## Property timeline

The Property page is event-oriented:

- The chart renders Cotality and Quantarium as continuous AVM lines.
- Realtor listing/sale/price-change records render as discrete markers.
- The ownership-history strip zooms out across recorded sales while the chart
  focuses on the denser AVM period.
- The Timeline tab uses `Date`, `Event`, `Value`, and `Change` columns. Estimate
  rows keep low/high range inline with the estimate value; market rows show
  list/sale/price-change values independently.

Use **Backfill history** on a Property page to populate `historical_estimates`
and `property_events` for that property.

## Scheduled refreshes

Not wired up yet — v1 ships manual refresh only (per-property and
"Refresh all" on the dashboard). The intended cadence is twice per month; the
endpoint `POST /api/properties/refresh-all` is the obvious hook for a cron or
launchd job later.

## Auth

None. Local-only for v1. The frontend talks to the backend over plain HTTP,
and the backend has no user model — easy to bolt a session layer on top later
without disturbing storage.
