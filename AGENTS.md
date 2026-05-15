# AGENTS.md

Operating notes for AI coding agents working on this repo.

## What this is

A local-first dashboard for tracking home prices over time. The backend scrapes
Realtor.com via [HomeHarvest](https://github.com/Bunsly/HomeHarvest) and stores
each fetch as an append-only snapshot in SQLite. The frontend is a no-build
React app (UMD + Babel-standalone) that the backend also serves.

## Layout

```
backend/app/
  main.py        FastAPI routes + serves the frontend at /
  scraper.py     HomeHarvest wrapper; normalizes AVM data
  store.py       SQLite reads/writes (append-only snapshots)
  db.py          schema + connection helper (data/app.db)
  models.py      pydantic types (currently unused by routes)
frontend/
  index.html     loads /static/* via UMD React + Babel
  styles.css     all visual tokens; from the design bundle
  components.jsx shared UI (icons, badges, formatters, JsonViewer)
  chart.jsx      PriceChart (estimate line + range band)
  pages.jsx      Dashboard, AddProperty, PropertyDetail
  app.jsx        app shell, hash router, data fetching
  api.js         tiny fetch wrapper exposed as window.API
run.sh           uvicorn dev launcher (port 5173)
data/app.db      SQLite database, auto-created on first run
```

## Run it

```bash
./run.sh                # http://127.0.0.1:5173
PORT=5180 ./run.sh      # alt port
```

The first request creates `data/app.db`. To reset, delete `data/app.db*`.

## Architectural rules

1. **HomeHarvest runs server-side only.** The frontend never imports it or hits
   realtor.com directly. All scraping flows through `backend/app/scraper.py`.
2. **Snapshots are append-only.** Refreshing a property inserts a new row in
   `snapshots`; it never updates an old one. `update_property_meta` only
   refreshes light fields on the parent `properties` row.
3. **Adding the same address must not duplicate the property.** `store.find_property_by_address`
   matches case- and whitespace-insensitive against both `input_address` and
   `canonical_address`; new fetches for an existing address append a snapshot.
4. **Raw HomeHarvest JSON is preserved per snapshot** in `snapshots.raw_json`
   for debugging/audit. Don't strip it.
5. **AVM data lives in two shapes.** `scraper._normalize_estimates` handles
   both `raw["current_estimates"]` (flat snake_case) and
   `raw["estimates"]["currentValues"]` (nested camelCase). Preference order:
   entry flagged `isBestHomeValue` → first entry. Keep this normalizer in one
   place; don't fork it.
6. **No build step on the frontend.** JSX is transpiled at runtime by Babel.
   If you add a file, register it in `index.html` with `type="text/babel"` and
   expose any new component on `window` so other files can use it.

## Data model

`properties` is one row per tracked address. `snapshots` is the history; the
"current" view of a property is just its newest snapshot.

```
properties(id, input_address, canonical_address, city, state, zip,
           property_id, listing_id, property_url, listing_state,
           active, status, created_at, updated_at)
snapshots (id, property_id, fetched_at, status, matched_address,
           best_current_estimate, estimate_source,
           estimate_low, estimate_high, estimate_date,
           list_price, sold_price, last_sold_price,
           beds, baths, sqft, lot_sqft, year_built,
           latitude, longitude, raw_json, error)
```

`status` is one of: `matched`, `candidate_mismatch`, `no_candidates`, `error`.

Timestamps (`created_at`, `updated_at`, `fetched_at`) are **milliseconds since
epoch** — the frontend treats them as JS `Date`-compatible numbers. Don't
switch to seconds without updating the frontend formatters.

## API contract

| Method | Path                              | Body / Notes                                    |
|-------:|-----------------------------------|-------------------------------------------------|
| GET    | `/api/properties`                 | List + latest snapshot for each                 |
| GET    | `/api/properties/{id}`            | Full property + full snapshot history           |
| POST   | `/api/properties`                 | `{address, confirm_mismatch?}` — see below      |
| POST   | `/api/properties/{id}/refresh`    | Appends a new snapshot                          |
| POST   | `/api/properties/refresh-all`     | Appends a snapshot for every property           |

`POST /api/properties` returns one of:

- `matched` — saved; property + snapshots in response.
- `candidate_mismatch` — **not yet saved.** `candidate` describes what
  HomeHarvest returned. Caller must retry with `confirm_mismatch: true` to
  persist.
- `no_candidates` — HomeHarvest returned nothing.
- `error` — upstream failure. `error` field has the message.

## Conventions

- Backend uses stdlib `sqlite3` directly. No ORM. Keep it that way unless we
  outgrow SQL strings.
- Frontend uses `window.X = X` exports because there's no module system. New
  files must expose anything other modules need on `window`.
- All currency display goes through `fmt.usd` / `fmt.delta` / `fmt.pct` in
  [components.jsx](frontend/components.jsx) — don't recompute formatting inline.
- CSS lives entirely in [styles.css](frontend/styles.css), driven by `--*`
  tokens. Light/dark themes are toggled via `data-theme` on `<html>`.

## What's deliberately not built (and why)

- **Scheduled refreshes.** v1 is manual only. The intent is twice/month later;
  the hook is `POST /api/properties/refresh-all`. Wire a cron/launchd job to
  it — don't bake scheduling into the FastAPI process.
- **Auth.** Local single-user. The backend has no user model so a session
  layer can be added without touching storage.
- **Admin/jobs page.** The design has one; the spec didn't ask for it. The
  "Refresh all" button lives on the Dashboard instead.

If you're tempted to add any of these, confirm with the user first.

## Testing

There's no test suite yet. Smoke-test manually:

```bash
./run.sh &
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"address":"5907 Cape Hatteras Dr, Houston, TX 77041"}' \
  http://127.0.0.1:5173/api/properties
curl -s http://127.0.0.1:5173/api/properties
```

Re-posting the same address should keep `count(*) FROM properties` at 1 and
increment `count(*) FROM snapshots`.
