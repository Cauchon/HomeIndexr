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
  comps.py       pure comparable ranking/gating over cached ZIP listings (rule #15)
  ai.py          DeepSeek chat + tool-calling loop (web_search/geocode); MAX_TOOL_STEPS / MAX_WEB_SEARCHES caps
  db.py          schema + connection helper (data/app.db) — authoritative table definitions
  models.py      pydantic types (currently unused by routes)
backend/test_*.py unittest coverage: scraper state, API/store flows, comps ranking, AI tool loop
frontend/
  index.html     loads /static/* via UMD React + Babel
  styles.css     all visual tokens; from the design bundle
  components.jsx shared UI (icons, badges, formatters, JsonViewer)
  chart.jsx      PriceChart (AVM lines; event rows/ownership strip live in pages.jsx)
  pages.jsx      Dashboard, AddProperty, PropertyDetail, Admin/RefreshJobs
  app.jsx        app shell, hash router, data fetching
  api.js         tiny fetch wrapper exposed as window.API
extension/       MV3 Chrome extension — thin client over the API (see below)
run.sh           uvicorn dev launcher (port 5173)
data/app.db      SQLite database, auto-created on first run
```

## Browser extension

`extension/` is an unpacked MV3 Chrome extension ("Add to HomeIndexr") that
tracks the Zillow/Realtor.com property in the active tab. It is a **thin client
over the existing API** — it scrapes the listing's address from the page and
calls `POST /api/properties {address}`; the backend does all Realtor matching
(rule #1 still holds — the extension only reads the address already rendered on
the listing page; it never calls Realtor's GraphQL, so all data fetching stays
server-side). It also
uses `GET /api/properties` (reachability + already-tracking check), and the
per-property `GET …/{id}` and `POST …/{id}/refresh`. Plain HTML/CSS/JS, no build
step. Address extraction runs on demand via `chrome.scripting.executeScript`
(`activeTab`), and the popup fetches the local server directly (the existing
permissive CORS + local `host_permissions` make a background worker unnecessary).
Keep this in lockstep with the API contract below. See `extension/README.md`.

## Run it

```bash
./run.sh                # http://127.0.0.1:5173
PORT=5180 ./run.sh      # alt port
```

Server startup creates `data/app.db`. To reset, delete `data/app.db*`.

Optional AI features use DeepSeek. Put `DEEPSEEK_API_KEY` in the process
environment or local `.env`; never hardcode it or store it in SQLite.

The AI research assistant can call tools to answer questions the stored data
doesn't cover. `web_search` (Brave) is enabled when `BRAVE_API_KEY` is present;
`geocode_address`/`reverse_geocode` (Nominatim) need no key. Treat `BRAVE_API_KEY`
like `DEEPSEEK_API_KEY`: environment or ignored `.env` only, never SQLite.

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
   for debugging. Don't strip it. Listing photos are derived from it at read
   time (`scraper.extract_photos`, surfaced as `photos` on the detail endpoint),
   not stored separately — keep that derivation in one place, like
   `all_estimates`. The detail query requests `photos { href tags { label } }`.
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
8. **School detail rows are current-detail data, not historical series.**
   Current Realtor school records are normalized into `property_schools` and
   replaced on add/refresh. `GET /api/properties/{id}` returns them as `schools`.
9. **The Property timeline is event-shaped.**
   List/sale/price-change events should render as their own rows. Estimate
   rows should keep low/high range visually attached to the estimate value
   instead of spreading it across disconnected columns.
10. **No build step on the frontend.** JSX is transpiled at runtime by Babel.
   If you add a file, register it in `index.html` with `type="text/babel"` and
   expose any new component on `window` so other files can use it.
11. **Scheduled refreshes stay outside FastAPI.** The Admin panel's Refresh
   jobs function can run `POST /api/properties/refresh-all`, show latest issue
   status, and persist the selected cadence in localStorage. There is no
   scheduler script checked into this repo right now. If real scheduling is
   added, wire cron/launchd or another external runner to the API endpoint
   instead of adding cron/looping work inside the FastAPI process.
12. **Archived properties are soft-hidden, not deleted.** `properties.active = 0`
    removes a row from the default dashboard and refresh-all sweeps while
    preserving current state, raw JSON, historical AVMs, events, and taxes.
    `DELETE /api/properties/{id}` is the permanent removal path.
13. **AI secrets stay out of app data.** `app_settings` may store non-secret
    flags such as `ai_enabled`, but API keys (`DEEPSEEK_API_KEY`, the optional
    `BRAVE_API_KEY` for web search) must come from the server environment or
    ignored local `.env`. API responses may report key presence/source, never
    the key value.
14. **Area listings are a per-ZIP cache, written only by user-initiated
    property refresh.** `scraper.fetch_area_listings` runs Realtor's
    `home_search` (SRP) for one ZIP, single page, no pagination. Refresh writes
    the result to `area_listings` keyed by ZIP; `refresh-all` dedupes so each
    unique ZIP is fetched once, not once per property. `GET /api/properties/{id}/area`
    serves this cache only and must never trigger a Realtor fetch — opening a
    detail page adds no upstream traffic. The area fetch is best-effort
    (`store.refresh_area_for_zip` swallows errors) so a block or hiccup never
    fails the core property refresh; the last good cache row stays in place.
15. **Comparables are derived at read time, not cached.** `comps.rank_comparables`
    (pure, in `backend/app/comps.py`) gates the cached ZIP listings to strict
    appraisal-style comps (same `property_type`, living area within ±25%, beds
    ±1) and ranks survivors by a weighted similarity score (sqft, distance via
    haversine, year, beds, baths, lot). It keeps the strictest rung that yields
    any comp and only relaxes when a rung is empty (±40% sqft → drop beds gate →
    nearest-by-score), reporting which rung via `relaxed`. The `/area` endpoint
    runs this against the cache, so the same cached ZIP serves different comps
    per subject and a subject's attributes can change on refresh without
    re-fetching. Keep ranking in this one pure module — don't fork the scoring.
   The comp filter pills (price/beds/baths/sqft) are applied **server-side**:
   `rank_comparables` takes an optional `filters` dict and pre-filters candidates
   via `_passes_user_filter` before the gate ladder, so a filter draws the best
   comps from the whole cached pool rather than subtracting from the shown page.
   `comps.comp_domain` returns the *unfiltered* price/sqft spread (+ count) so the
   frontend sliders stay stable across filter changes. Still cache-only — applying
   a filter re-ranks the cache and never triggers a Realtor fetch.

## Data model

`db.py` holds the authoritative table definitions — read it for exact columns
rather than duplicating the schema here. The shape at a glance:

- `properties` — one row per tracked address with the latest fetched Realtor.com
  state (identity/match fields, current AVM + price fields, physical attributes,
  flags, `raw_json`, timestamps).
- `property_schools` — current school records, replaced on add/refresh (rule #8).
- `historical_estimates` — monthly AVM history per source (rule #7).
- `property_events` — sparse Realtor market events (`Listed`, `Sold`, …) (rule #7).
- `observed_events` — same-listing list-price changes the app itself saw (rule #7).
- `tax_history` — yearly tax + county assessment/market/appraisal values.
- `area_listings` — per-ZIP SRP cache, one row per ZIP (rule #14).
- `app_settings` — non-secret key/value flags (rule #13).

`status` is one of: `matched`, `candidate_mismatch`, `no_candidates`, `error`.

`listing_state` is one of: `for_sale`, `pending`, `sold`, `off_market`.
`sold` is only for recent sales inside the configured 180-day sold window; older
sold/closed records are considered `off_market` for dashboard filtering.

Timestamps (`created_at`, `updated_at`, `last_fetched_at`, and history/event/tax
and school `fetched_at`) are **milliseconds since epoch** — the frontend treats
them as JS `Date`-compatible numbers. Don't switch to seconds without updating
the frontend formatters.

## API contract

| Method | Path                              | Body / Notes                                    |
|-------:|-----------------------------------|-------------------------------------------------|
| GET    | `/api/properties`                 | List properties with current state              |
| GET    | `/api/admin/ai-settings`          | AI enabled/key-present status                   |
| PATCH  | `/api/admin/ai-settings`          | Update non-secret AI settings                   |
| GET    | `/api/properties/{id}`            | Full property + historical + events + taxes + schools + `photos` (`[{href, label}]`, derived from `raw_json`) |
| GET    | `/api/properties/{id}/area`       | Comparable for-sale homes in this property's ZIP (cache-only; excludes the subject; strict gating + similarity ranking). Optional filter query params (`min_price`, `max_price`, `min_beds`, `min_baths`, `min_sqft`, `max_sqft`) narrow the candidate pool *before* ranking. `{zip, fetched_at, comps, relaxed, limited, subject_price_per_sqft, domain}` where `domain` (`{prices, sqfts, count}`) describes the unfiltered comp spread for stable filter sliders. |
| POST   | `/api/properties/{id}/ai/ask`     | `{question}` — server-side DeepSeek answer grounded in local property context; may call web-search/geocoding tools. Returns `tools_used` |
| POST   | `/api/properties`                 | `{address, confirm_mismatch?}` — see below      |
| PATCH  | `/api/properties/{id}`            | Edit `property_name`, `input_address`, `canonical_address`, `city`, `state`, `zip`, `active` |
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
- When `property_name` is set, use it as the primary property display label on
  dashboard/detail surfaces while keeping the full address visible as supporting
  context and searchable for filtering.
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

Run the unittest suite from the repo root:

```bash
PYTHONPATH=backend .venv312/bin/python -m unittest discover -s backend -p 'test_*.py'
```

**Test DB isolation is mandatory — tests must never touch `data/app.db`.**
This bit us once: a test module imported `app` (and therefore `app.db`) before
redirecting the database, the path got bound to the real `data/app.db`, and a
test reset wiped real user data. Two non-negotiable safeguards:

1. `db.db_path()` resolves the SQLite path lazily on every connection — never
   reintroduce an import-time `DB_PATH` constant that freezes it.
2. Every test module that imports `app` must set `HOMEINDEXR_DB_PATH` (and
   `HOMEINDEXR_DOTENV_PATH`) to a throwaway `tempfile` path *before* the
   `from app import ...` line, exactly as `test_main.py` / `test_ai.py` /
   `test_scraper.py` do. Any new `test_*.py` must copy that preamble.

After running the suite, `data/app.db` must be unmodified (check its mtime).

Smoke-test manually when touching live Realtor fetch behavior:

```bash
./run.sh &
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"address":"5907 Cape Hatteras Dr, Houston, TX 77041"}' \
  http://127.0.0.1:5173/api/properties
curl -s http://127.0.0.1:5173/api/properties
```

Re-posting the same address should keep `count(*) FROM properties` at 1 and
update that existing row.
