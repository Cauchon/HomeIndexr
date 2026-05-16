# AGENTS.md

Operating notes for AI coding agents working on this repo.

## What this is

A local-first dashboard for tracking home prices over time. The backend scrapes
Realtor.com via [HomeHarvest](https://github.com/Bunsly/HomeHarvest) and stores
the latest fetched state on each property row in SQLite. The frontend is a
no-build React app (UMD + Babel-standalone) that the backend also serves.

## Layout

```
backend/app/
  main.py        FastAPI routes + serves the frontend at /
  scraper.py     HomeHarvest/Realtor wrappers; normalizes AVM + history data
  store.py       SQLite reads/writes (current property state + history/events)
  db.py          schema + connection helper (data/app.db)
  models.py      pydantic types (currently unused by routes)
frontend/
  index.html     loads /static/* via UMD React + Babel
  styles.css     all visual tokens; from the design bundle
  components.jsx shared UI (icons, badges, formatters, JsonViewer)
  chart.jsx      PriceChart (AVM lines + Realtor event markers)
  pages.jsx      Dashboard, AddProperty, PropertyDetail, Admin/RefreshJobs
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
2. **Current HomeHarvest data lives on `properties`.** Refreshing a property
   overwrites the current normalized fields and raw JSON on the existing row.
3. **Adding the same address must not duplicate the property.** `store.find_property_by_address`
   matches case- and whitespace-insensitive against both `input_address` and
   `canonical_address`; new fetches for an existing address update that row.
4. **Raw HomeHarvest JSON is preserved on the property row** in `properties.raw_json`
   for debugging. Don't strip it.
5. **AVM data lives in two shapes.** `scraper._normalize_estimates` handles
   both `raw["current_estimates"]` (flat snake_case) and
   `raw["estimates"]["currentValues"]` (nested camelCase). Preference order:
   entry flagged `isBestHomeValue` → first entry. Keep this normalizer in one
   place; don't fork it.
6. **Historical AVMs and Realtor market events are separate from current state.**
   Backfill writes `historical_estimates` for monthly AVM history and
   `property_events` for sparse market events such as `Listed`, `Sold`,
   `Price Changed`, `Relisted`, and `Listing removed`. Do not fold those into
   the current property row just to make the frontend simpler.
7. **The Property timeline is event-shaped.**
   List/sale/price-change events should render as their own rows. Estimate
   rows should keep low/high range visually attached to the estimate value
   instead of spreading it across disconnected columns.
8. **No build step on the frontend.** JSX is transpiled at runtime by Babel.
   If you add a file, register it in `index.html` with `type="text/babel"` and
   expose any new component on `window` so other files can use it.
9. **Refresh scheduling UI is not a backend scheduler.** The Refresh jobs page
   can run `POST /api/properties/refresh-all`, show latest issue status, and
   persist the selected cadence in localStorage. Do not add cron/looping work
   inside the FastAPI process; wire external cron/launchd to the API endpoint
   when real scheduling is needed.

## Data model

`properties` is one row per tracked address and includes the latest fetched
HomeHarvest state.

```
properties(id, input_address, canonical_address, city, state, zip,
           property_id, listing_id, property_url, listing_state,
           active, status, matched_address,
           best_current_estimate, estimate_source,
           estimate_low, estimate_high, estimate_date,
           list_price, sold_price, last_sold_price,
           beds, baths, sqft, lot_sqft, year_built,
           latitude, longitude, raw_json, error, last_fetched_at,
           created_at, updated_at)
historical_estimates(property_id, source, date, estimate)
property_events(property_id, date, event_name, price)
```

`status` is one of: `matched`, `candidate_mismatch`, `no_candidates`, `error`.

Timestamps (`created_at`, `updated_at`, `last_fetched_at`, and history/event
`fetched_at`) are **milliseconds since epoch** — the frontend treats them as JS
`Date`-compatible numbers. Don't switch to seconds without updating the
frontend formatters.

## API contract

| Method | Path                              | Body / Notes                                    |
|-------:|-----------------------------------|-------------------------------------------------|
| GET    | `/api/properties`                 | List properties with current state              |
| GET    | `/api/properties/{id}`            | Full property + historical + events             |
| POST   | `/api/properties`                 | `{address, confirm_mismatch?}` — see below      |
| POST   | `/api/properties/{id}/refresh`    | Refreshes current property state                |
| POST   | `/api/properties/{id}/backfill`   | Upserts historical AVMs + Realtor events        |
| POST   | `/api/properties/refresh-all`     | Refreshes current state for every property      |
| POST   | `/api/properties/backfill-all`    | Backfills history/events for every property     |

`POST /api/properties` returns one of:

- `matched` — saved; property in response.
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
- The detail chart should keep AVM sources as continuous monthly lines and
  Realtor listing/sale/price-change history as discrete dated markers.

## What's deliberately not built (and why)

- **Scheduled refreshes.** v1 is manual only. The intent is twice/month later;
  the hook is `POST /api/properties/refresh-all`. Wire a cron/launchd job to
  it — don't bake scheduling into the FastAPI process.
- **Auth.** Local single-user. The backend has no user model so a session
  layer can be added without touching storage.

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
update that existing row.
