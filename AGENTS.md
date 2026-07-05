# AGENTS.md

Operating notes for AI coding agents working on this repo.

## What this is

A local-first dashboard for tracking home prices over time. The server scrapes
Realtor.com directly via their `frontdoor/graphql` endpoint and stores the
latest fetched state on each property row in SQLite. It's a **TanStack Start +
Vite** app (TypeScript): the same process serves the React SPA and the `/api/*`
routes. It runs on Node only (no Python) — that's what lets it deploy on hosts
like Poke that can run `vite`/Node but not a raw Python server.

## Layout

```
src/
  router.tsx            TanStack Router factory (getRouter)
  routeTree.gen.ts      generated route tree (do not edit by hand)
  routes/
    __root.tsx          HTML shell: <head> (fonts, favicon), data-theme
    index.tsx           mounts the SPA client-only (ssr: false) + imports styles.css
    api/$.ts            catch-all server route → forwards every method to handle_api
  server/               the ported backend (was backend/app/*.py)
    api.ts              request dispatcher for the whole /api/* contract (was main.py)
    scraper.ts          Realtor.com GraphQL client; AVM + history normalization
                        (Python scraper.fetch() is exported here as fetch_property())
    store.ts            SQLite reads/writes (node-sqlite3-wasm) + secrets from env/.env
    db.ts               schema + connect()/db_path()/init_db() — authoritative tables
    env.ts              get_env(): process.env first, then an ignored local .env
    comps.ts            pure comparable ranking/gating over cached ZIP listings (rule #15)
    browse.ts           pure Browse-pool aggregation over the area-listings cache (rule #16)
    rates.ts            live FRED (Freddie Mac PMMS) rate anchor; daily app_settings cache (rule #17)
    ai.ts               DeepSeek chat + tool-calling loop; MAX_TOOL_STEPS / MAX_WEB_SEARCHES caps
    pyround.ts          Python-faithful round-half-to-even (used where a rounded value is API-visible)
    __tests__/*.test.ts vitest: comps ranking, Browse pool + endpoint, FRED rate fetch/cache
  app/                  the ported frontend (was frontend/*.jsx), now ES modules
    styles.css          all visual tokens; from the design bundle
    components.jsx      shared UI (icons, badges, formatters, JsonViewer, Markdown)
    chart.jsx           PriceChart (AVM lines; event rows/ownership strip live in pages.jsx)
    pages.jsx           Dashboard, AddProperty, PropertyDetail, Admin/RefreshJobs
    browse.jsx          Browse page — chip filter bar + card grid over /api/browse (rule #16)
    coverage.jsx        Tracked areas admin tab over /api/admin/areas (rule #14)
    mortgage.jsx        Mortgage calculator (client-side estimate; live rate anchor via /api/mortgage-rates)
    app.jsx             app shell, hash router, data fetching (exports App; the index route mounts it)
    api.js              tiny fetch wrapper (exported as `API`)
public/favicon.svg      static asset served at /favicon.svg
vite.config.ts          tanstackStart() + viteReact() plugins
vitest.config.ts        test config (avoids loading the Start plugin)
extension/              MV3 Chrome extension — thin client over the API (see below)
data/app.db             SQLite database, auto-created on first run
backend/                the retired Python app, kept for reference during the port
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
npm install             # first time — no native build (WASM SQLite, pure JS deps)
npm run dev             # http://localhost:5173
```

`npm run build` produces the client + SSR bundles under `dist/`; `npm start`
(`node serve.mjs`) wraps the built fetch-handler in a node:http server that
serves `dist/client` statics and delegates SSR + `/api/*` to the handler. The
first request creates `data/app.db` (schema ensured lazily on connect). To
reset, delete `data/app.db*`.

**SQLite driver: `node-sqlite3-wasm` (WASM), not native.** This is deliberate —
`better-sqlite3` is a native C++ addon that needs a node-gyp toolchain to
compile, which timed out on the Node-only deploy host (Poke). The WASM driver
has nothing to compile, so `npm install` + `vite build` are pure JS. Two
consequences to respect:
- It's kept **external** in the SSR build (`ssr.external` in `vite.config.ts`)
  because it loads its `.wasm` via `readFileSync(__dirname/...)`; bundling would
  break that path. And it's imported as a **default** (`import sqlite3wasm from
  'node-sqlite3-wasm'`), not a named import — it's CommonJS, and a named ESM
  import fails in the built bundle.
- The WASM VFS **cannot open a WAL-mode database.** New DBs are created in the
  default DELETE journal mode and work fine. A DB created by the old
  better-sqlite3 build is WAL — convert it once:
  `sqlite3 data/app.db "PRAGMA journal_mode=DELETE;"`. `connect()` throws a
  message saying exactly this if it hits a WAL file.

Node 20+ is required (native `fetch`, `AbortSignal.timeout`, `Readable.toWeb`).
There is no Python runtime dependency anymore.

Optional AI features use DeepSeek. Put `DEEPSEEK_API_KEY` in the process
environment or local `.env`; never hardcode it or store it in SQLite.

The AI research assistant can call tools to answer questions the stored data
doesn't cover. `web_search` (Brave) is enabled when `BRAVE_API_KEY` is present;
`geocode_address`/`reverse_geocode` (Nominatim) need no key. Treat `BRAVE_API_KEY`
like `DEEPSEEK_API_KEY`: environment or ignored `.env` only, never SQLite.

The mortgage calculator's suggested-rate anchor can be sourced live from the
St. Louis Fed's FRED API (Freddie Mac PMMS) when `FRED_API_KEY` is set. The key
is optional and follows the same rule as the others (environment or ignored
`.env`, never SQLite); the *fetched rate values* are non-secret and are cached
in `app_settings` (rule #17). With no key the calculator falls back to its
hardcoded national-average anchor — fully functional, just not live.

## Architectural rules

1. **Realtor scraping runs server-side only.** The frontend never hits
   realtor.com directly. All scraping flows through `src/server/scraper.ts`,
   which POSTs GraphQL operations to `https://www.realtor.com/frontdoor/graphql`
   via the shared `_post_gql` helper. (Python's top-level `scraper.fetch()` is
   exported as `fetch_property()` here to avoid shadowing the global `fetch`;
   every other function keeps its Python name, and the GraphQL documents are
   copied verbatim.) `src/server/*` runs only on the server — never import it
   into `src/app/*`.
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
10. **The frontend is Vite-built ES modules.** JSX under `src/app/` is compiled
   by Vite (`@vitejs/plugin-react`) — there is no Babel-standalone/`window.X`
   global mechanism anymore. Add a file as an ES module and `export` what other
   files need; import it where used. The whole SPA mounts client-only from
   `src/routes/index.tsx` (`ssr: false`), so render-time `window`/`localStorage`
   access is safe. Keep browser-only code out of `src/server/*`.
11. **Scheduled refreshes stay outside the app process.** The Admin panel's
   Refresh jobs function can run `POST /api/properties/refresh-all`, show latest
   issue status, and persist the selected cadence in localStorage. There is no
   scheduler script checked into this repo right now. If real scheduling is
   added, wire cron/launchd or another external runner to the API endpoint
   instead of adding cron/looping work inside the Node server process.
12. **Archived properties are soft-hidden, not deleted.** `properties.active = 0`
    removes a row from the default dashboard and refresh-all sweeps while
    preserving current state, raw JSON, historical AVMs, events, and taxes.
    `DELETE /api/properties/{id}` is the permanent removal path.
13. **AI secrets stay out of app data.** `app_settings` may store non-secret
    flags such as `ai_enabled`, but API keys (`DEEPSEEK_API_KEY`, the optional
    `BRAVE_API_KEY` for web search) must come from the server environment or
    ignored local `.env`. API responses may report key presence/source, never
    the key value.
14. **Area listings are a per-ZIP cache, written only by explicit user action.**
    `scraper.fetch_area_listings` runs Realtor's `home_search` (SRP) for one ZIP,
    single page, no pagination. Two user-initiated paths write `area_listings`
    (keyed by ZIP): (a) **property refresh** — adding/refreshing a property crawls
    its whole ZIP, and `refresh-all` dedupes so each unique ZIP is fetched once,
    not once per property; (b) **Tracked areas** (Admin) — a user can add a ZIP or
    re-crawl one directly via `POST /api/admin/areas` / `…/recrawl`. Both go
    through `scraper.fetch_area_listings`, server-side (rule #1). What stays
    forbidden is *implicit* fetching: `GET /api/properties/{id}/area` and
    `GET /api/browse` serve the cache only and must never trigger a Realtor fetch —
    opening a detail or Browse page adds no upstream traffic. The refresh-time area
    fetch is best-effort (`store.refresh_area_for_zip` swallows errors) so a block
    never fails the core property refresh; the foreground Tracked-areas crawl
    (`store.crawl_area_zip`) lets the error propagate so the Admin UI reports it.
    Each cache row carries a `status` (`active`/`paused`); a paused ZIP keeps its
    index but is excluded from Browse (rule #16). Tracked areas are managed via
    `store.list_area_coverage` / `set_area_status` / `delete_area_listings`; a ZIP
    that backs an active tracked property is **locked** (origin/lock derived live
    from property membership) and can't be removed until that property is gone.
15. **Comparables are derived at read time, not cached.** `comps.rank_comparables`
    (pure, in `src/server/comps.ts`) gates the cached ZIP listings to strict
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
16. **Browse is a cache-only discovery pool, never a new fetch.** `GET /api/browse`
    unions the *active* (non-paused) `area_listings` cache (every ZIP, populated
    per rule #14) into one pool via `browse.build_pool` (pure, in
    `src/server/browse.ts`): deduped by Realtor `property_id` (newest ZIP cache
    wins), with homes already tracked removed (matched against
    `properties.property_id`) and a `price_per_sqft` attached. `browse.pool_facets`
    derives the filter facets — value bounds (rounded outward to the real pool), a
    24-bucket price histogram, the cities present, and a per-status count.
    Filtering/sorting run **client-side** in `src/app/browse.jsx` over the whole
    (bounded) pool — the design's Option B chip bar + card grid — so the server
    just shapes the pool and supplies stable slider bounds. Opening Browse must
    add no upstream traffic; keep the aggregation in this one pure module. The
    per-card "Track home" reuses the comp-card add flow (`useTrackComp`,
    `navigateOnSuccess: false`), so tracking POSTs the listing's address through
    the normal server-side Realtor match.
17. **The mortgage rate anchor is live-optional and never blocks the calculator.**
    `src/server/rates.ts` fetches the Freddie Mac PMMS 30-/15-yr averages from
    FRED (`MORTGAGE30US`/`MORTGAGE15US`) when `FRED_API_KEY` is configured and
    caches them daily in `app_settings` (PMMS publishes weekly). `GET
    /api/mortgage-rates` serves that cache; on a missing key, a fetch error, or
    a parse miss it reports `available: false` (serving stale cache first if any)
    and the frontend (`src/app/mortgage.jsx` `suggestedRate`) falls back to the
    static `BASE_RATE_30` anchor. The live value only replaces the *anchor*: the
    credit-band (`CREDIT_BANDS[].adj`) and 20/10-yr term spreads stay illustrative
    on top, and the 15-yr term uses the real `MORTGAGE15US` series directly rather
    than the synthetic offset. Keep the fetch+cache logic in `rates.ts`; the rate
    values are non-secret (so they live in `app_settings`), but the key is not.
18. **Saved Browse searches are server-persisted, not localStorage.** A saved
    search is just a named Browse filter set (`{id, name, filters, created_at}`)
    listed in the sidebar. It lives in the `saved_searches` table and is managed
    through `/api/saved-searches` (`store.list_saved_searches` /
    `create_saved_search` / `delete_saved_search`); the id is minted server-side.
    It was originally localStorage-only, which silently lost data on an
    origin/browser change — the frontend now loads from the API and performs a
    one-time migration of any leftover `hi_saved_searches` localStorage entries
    up to the server (then clears the key). The `filters` blob is opaque to the
    backend (stored as JSON); Browse owns its shape. Single-user app, so no user
    scoping (see *Auth*, deliberately not built).

## Data model

`src/server/db.ts` holds the authoritative table definitions — read it for exact columns
rather than duplicating the schema here. The shape at a glance:

- `properties` — one row per tracked address with the latest fetched Realtor.com
  state (identity/match fields, current AVM + price fields, physical attributes,
  flags, `raw_json`, timestamps).
- `property_schools` — current school records, replaced on add/refresh (rule #8).
- `historical_estimates` — monthly AVM history per source (rule #7).
- `property_events` — sparse Realtor market events (`Listed`, `Sold`, …) (rule #7).
- `observed_events` — same-listing list-price changes the app itself saw (rule #7).
- `tax_history` — yearly tax + county assessment/market/appraisal values.
- `area_listings` — per-ZIP SRP cache, one row per ZIP, with an `active`/`paused`
  `status` for Tracked-areas management (rule #14).
- `saved_searches` — named Browse filter sets surfaced in the sidebar; one row
  per search (`id`, `name`, `filters_json`, `created_at`). Single-user, so no
  scoping (rule #18).
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
| GET    | `/api/browse`                     | Cache-only Browse pool: all `area_listings` deduped, tracked homes excluded, each with `price_per_sqft`. Returns `{homes, total, zips, fetched_at, cities, statuses, bounds, price_hist}` (rule #16). Never calls Realtor. |
| GET    | `/api/mortgage-rates`             | Live national mortgage-rate anchor (Freddie Mac PMMS via FRED), cached daily in `app_settings`. Returns `{available, source, rate_30, rate_15, observation_date, fetched_at, key_present, key_env_var}`. `available: false` when no `FRED_API_KEY` is set; the calculator then falls back to its static anchor (rule #17). |
| GET    | `/api/admin/ai-settings`          | AI enabled/key-present status                   |
| PATCH  | `/api/admin/ai-settings`          | Update non-secret AI settings                   |
| GET    | `/api/admin/areas`                | Tracked-areas coverage: one record per cached ZIP `{zip, city, state, count, status, fetched_at, origin, locked}` (rule #14) |
| POST   | `/api/admin/areas`                | `{zip}` — add a ZIP and crawl it once server-side (synchronous; 400 bad ZIP, 409 dup, 502 crawl error). Returns the new record |
| POST   | `/api/admin/areas/{zip}/recrawl`  | Re-run the one-time SRP crawl for a tracked ZIP. Returns the updated record |
| PATCH  | `/api/admin/areas/{zip}`          | `{status}` (`active`\|`paused`) — pause hides the ZIP's homes from Browse but keeps its index |
| DELETE | `/api/admin/areas/{zip}`          | Discard a ZIP's index (409 if it backs an active tracked property) |
| GET    | `/api/saved-searches`             | Saved Browse filter sets, newest first: `[{id, name, filters, created_at}]` (rule #18) |
| POST   | `/api/saved-searches`             | `{name, filters}` — persist a named filter set; id minted server-side. Returns the record |
| DELETE | `/api/saved-searches/{id}`        | Remove a saved search (404 if the id is unknown) |
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

- The server uses SQLite directly (synchronous) via `node-sqlite3-wasm`, wrapped
  in a thin better-sqlite3-compatible adapter in `db.ts` (variadic binds, `.get()`
  null→undefined, statement finalize-on-close) so the rest of `src/server` uses
  the familiar `prepare().get()/.all()/.run()` API. No ORM. `db.connect()`
  resolves the path lazily on every call (`HOMEINDEXR_DB_PATH` → `data/app.db`)
  and ensures the schema once per path — never freeze the path in a module-level
  constant (test-DB isolation depends on the lazy resolution).
- The port keeps the Python snake_case function and result-key names so the
  `/api/*` JSON stays byte-compatible (the extension is a client). Where Python
  used `round()` on an API-visible value, use `pyround`/`pyround2` from
  `src/server/pyround.ts` (round-half-to-even), not `Math.round`.
- Frontend files are ES modules: `export` what other modules need and `import`
  it. No `window.X` globals.
- When `property_name` is set, use it as the primary property display label on
  dashboard/detail surfaces while keeping the full address visible as supporting
  context and searchable for filtering.
- All currency display goes through `fmt.usd` / `fmt.delta` / `fmt.pct` in
  [components.jsx](src/app/components.jsx) — don't recompute formatting inline.
- CSS lives entirely in [styles.css](src/app/styles.css), driven by `--*`
  tokens. Light/dark themes are toggled via `data-theme` on `<html>`.
- The detail chart should keep AVM sources as continuous monthly lines and
  Realtor listing/sale/price-change history as discrete dated markers.

## What's deliberately not built (and why)

- **Scheduled refreshes.** v1 is manual only. The intent is twice/month later;
  the hook is `POST /api/properties/refresh-all`. Wire a cron/launchd job to
  it — don't bake scheduling into the Node server process.
- **Auth.** Local single-user. The backend has no user model so a session
  layer can be added without touching storage.

If you're tempted to add any of these, confirm with the user first.

## Testing

Run the vitest suite from the repo root:

```bash
npm test                # vitest run
npx tsc --noEmit        # typecheck
npm run build           # client + SSR build must succeed
```

**Test DB isolation is mandatory — tests must never touch `data/app.db`.**
This bit us once (in the Python app): the DB path got bound to the real
`data/app.db` before a test redirected it, and a test reset wiped real user
data. Two non-negotiable safeguards carry over:

1. `db.db_path()` resolves the SQLite path lazily on every `connect()`, and the
   schema is ensured per-path — never reintroduce an import-time path constant
   that freezes it.
2. Every DB-touching test sets `HOMEINDEXR_DB_PATH` (and `HOMEINDEXR_DOTENV_PATH`)
   to a throwaway temp path *before the first `connect()`* — use `fresh_db()`
   from `src/server/__tests__/helpers.ts` in a `beforeEach`, as the Browse and
   rates tests do. Any new DB-touching test must do the same.

After running the suite, `data/app.db` must be unmodified (check its mtime).

Smoke-test manually when touching live Realtor fetch behavior. To avoid any risk
to real data, point the dev server at a copy of the DB:

```bash
cp data/app.db /tmp/smoke.db
HOMEINDEXR_DB_PATH=/tmp/smoke.db npm run dev &
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"address":"5907 Cape Hatteras Dr, Houston, TX 77041"}' \
  http://localhost:5173/api/properties
curl -s http://localhost:5173/api/properties
```

Re-posting the same address should keep `count(*) FROM properties` at 1 and
update that existing row.
