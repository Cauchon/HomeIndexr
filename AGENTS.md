# AGENTS.md

Operating notes for AI coding agents working on this repo.

## What this is

A local-first dashboard for tracking home prices over time. The backend scrapes
Realtor.com directly via their `frontdoor/graphql` endpoint and stores the
latest fetched state on each property row in SQLite. The frontend is a
no-build React app (UMD + Babel-standalone) that the backend also serves.

## Layout

```
backend/app/
  main.py        FastAPI routes + serves the frontend at /
  scraper.py     Realtor.com GraphQL client; normalizes AVM + history data
  store.py       SQLite reads/writes (current property state + history/events/taxes)
  db.py          schema + connection helper (data/app.db)
  models.py      pydantic types (currently unused by routes)
frontend/
  index.html     loads /static/* via UMD React + Babel
  styles.css     all visual tokens; from the design bundle
  components.jsx shared UI (icons, badges, formatters, JsonViewer)
  chart.jsx      PriceChart (AVM lines; event rows/ownership strip live in pages.jsx)
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

Server startup creates `data/app.db`. To reset, delete `data/app.db*`.

## Architectural rules

1. **Realtor scraping runs server-side only.** The frontend never hits
   realtor.com directly. All scraping flows through `backend/app/scraper.py`,
   which POSTs GraphQL operations to `https://www.realtor.com/frontdoor/graphql`
   via the shared `_post_gql` helper.
2. **Current Realtor data lives on `properties`.** Refreshing a property
   overwrites the current normalized fields and raw JSON on the existing row.
3. **Adding the same address must not duplicate the property.** `store.find_property_by_address`
   matches case- and whitespace-insensitive against both `input_address` and
   `canonical_address`; new fetches for an existing address update and
   reactivate that row.
4. **Raw Realtor JSON is preserved on the property row** in `properties.raw_json`
   for debugging. Don't strip it.
5. **AVM data lives in two shapes.** `scraper._normalize_estimates` handles
   both `raw["current_estimates"]` (flat snake_case) and
   `raw["estimates"]["currentValues"]` (nested camelCase). Preference order:
   entry flagged `isBestHomeValue` → first entry. Keep this normalizer in one
   place; don't fork it.
6. **Listing state is a normalized dashboard bucket.** Keep
   `scraper.normalize_listing_state` as the single source of truth for
   `for_sale`, `pending`, `sold`, and `off_market`. Sold/closed records remain
   `sold` for `SOLD_TO_OFF_MARKET_DAYS` (currently 180 days) after the sale date,
   then become `off_market`.
7. **Historical AVMs, Realtor market events, observed refresh events, and tax history are separate from current state.**
   Backfill writes `historical_estimates` for monthly AVM history and
   `property_events` for sparse market events such as `Listed`, `Sold`,
   `Price Changed`, `Relisted`, and `Listing removed`, plus `tax_history` for
   yearly tax and county assessment records. Refresh writes `observed_events`
   when the app itself sees a same-listing active list-price change. Do not fold
   those into the current property row just to make the frontend simpler.
8. **The Property timeline is event-shaped.**
   List/sale/price-change events should render as their own rows. Estimate
   rows should keep low/high range visually attached to the estimate value
   instead of spreading it across disconnected columns.
9. **No build step on the frontend.** JSX is transpiled at runtime by Babel.
   If you add a file, register it in `index.html` with `type="text/babel"` and
   expose any new component on `window` so other files can use it.
10. **Scheduled refreshes stay outside FastAPI.** The Refresh jobs page can run
   `POST /api/properties/refresh-all`, show latest issue status, and persist
   the selected cadence in localStorage. There is no scheduler script checked
   into this repo right now. If real scheduling is added, wire cron/launchd or
   another external runner to the API endpoint instead of adding cron/looping
   work inside the FastAPI process.
11. **Archived properties are soft-hidden, not deleted.** `properties.active = 0`
    removes a row from the default dashboard and refresh-all sweeps while
    preserving current state, raw JSON, historical AVMs, events, and taxes.
    `DELETE /api/properties/{id}` is the permanent removal path.

## Data model

`properties` is one row per tracked address and includes the latest fetched
Realtor.com state.

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
historical_estimates(property_id, source, date, estimate, fetched_at)
property_events(property_id, date, event_name, price, fetched_at)
observed_events(id, property_id, observed_at, event_name, source,
                listing_state, listing_id, old_price, new_price,
                price, delta, pct)
tax_history(property_id, year, assessed_year, tax,
            assessment_building, assessment_land, assessment_total,
            market_building, market_land, market_total,
            appraisal_building, appraisal_land, appraisal_total,
            value_building, value_land, value_total,
            tax_code_area, fetched_at)
```

`status` is one of: `matched`, `candidate_mismatch`, `no_candidates`, `error`.

`listing_state` is one of: `for_sale`, `pending`, `sold`, `off_market`.
`sold` is only for recent sales inside the configured 180-day sold window; older
sold/closed records are considered `off_market` for dashboard filtering.

Timestamps (`created_at`, `updated_at`, `last_fetched_at`, and history/event/tax
`fetched_at`) are **milliseconds since epoch** — the frontend treats them as JS
`Date`-compatible numbers. Don't switch to seconds without updating the
frontend formatters.

## API contract

| Method | Path                              | Body / Notes                                    |
|-------:|-----------------------------------|-------------------------------------------------|
| GET    | `/api/properties`                 | List properties with current state              |
| GET    | `/api/properties/{id}`            | Full property + historical + events + taxes     |
| POST   | `/api/properties`                 | `{address, confirm_mismatch?}` — see below      |
| PATCH  | `/api/properties/{id}`            | Edit `input_address`, `canonical_address`, `city`, `state`, `zip`, `active` |
| POST   | `/api/properties/{id}/archive`    | Sets `active = 0`                                |
| POST   | `/api/properties/{id}/restore`    | Sets `active = 1`                                |
| DELETE | `/api/properties/{id}`            | Permanently deletes property + related rows      |
| POST   | `/api/properties/{id}/refresh`    | Refreshes current property state                |
| POST   | `/api/properties/{id}/backfill`   | Upserts historical AVMs + Realtor events + taxes |
| POST   | `/api/properties/refresh-all`     | Refreshes current state for active properties   |
| POST   | `/api/properties/backfill-all`    | Backfills history/events/taxes for every property |

`POST /api/properties` returns one of:

- `matched` — saved; property in response.
- `candidate_mismatch` — **not yet saved.** `candidate` describes the
  property Realtor resolved. Caller must retry with `confirm_mismatch: true`
  to persist.
- `no_candidates` — Realtor returned no address match.
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
