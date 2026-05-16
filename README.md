# HomeIndexr

Local-first dashboard for tracking home prices over time. Fetches property data
from Realtor.com via [HomeHarvest](https://github.com/Bunsly/HomeHarvest)
server-side and stores the latest fetched state on each tracked property in
SQLite. The Property view can also backfill Realtor historical AVMs, sparse
market events, and tax assessment history.

## Stack

- **Backend**: FastAPI + sqlite3 (stdlib), HomeHarvest for scraping.
- **Frontend**: React (via UMD + Babel-standalone) served as static files by the
  backend. No build step.
- **Storage**: `data/app.db` (SQLite, WAL mode). Auto-created on first run.

## Setup

Use Python 3.12 for this project. HomeHarvest 0.8.18 did not import reliably
under the system Python 3.9 on this machine.

```bash
python3.12 -m venv .venv312
.venv312/bin/python -m pip install \
  fastapi==0.136.1 \
  homeharvest==0.8.18 \
  uvicorn==0.47.0 \
  requests==2.34.1 \
  pydantic==2.13.4
```

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
| GET    | `/api/properties`                     | List properties with current state     |
| GET    | `/api/properties/{id}`                | Property + history + events + taxes    |
| POST   | `/api/properties`                     | Add a property (returns match status)  |
| PATCH  | `/api/properties/{id}`                | Edit address/display fields and active state |
| POST   | `/api/properties/{id}/archive`        | Hide from default dashboard and refresh-all |
| POST   | `/api/properties/{id}/restore`        | Restore an archived property           |
| DELETE | `/api/properties/{id}`                | Delete property plus history/events/taxes |
| POST   | `/api/properties/{id}/refresh`        | Refresh current property state         |
| POST   | `/api/properties/{id}/backfill`       | Upsert AVMs, market events, taxes      |
| POST   | `/api/properties/refresh-all`         | Refresh current state for active properties |
| POST   | `/api/properties/backfill-all`        | Backfill history/events/taxes for all records |

`POST /api/properties` returns one of:
`matched`, `candidate_mismatch`, `no_candidates`, `error`. A
`candidate_mismatch` requires a second call with `confirm_mismatch: true` to
save.

## Data model

- `properties` — one row per tracked address, including the latest normalized
  AVM, list/sale prices, property facts, match status, and raw HomeHarvest JSON.
- `historical_estimates` — monthly historical AVM series keyed by property,
  source, and date.
- `property_events` — Realtor market events such as listed, sold, relisted,
  listing removed, and price changed.
- `tax_history` — yearly Realtor tax bills and county assessment values.

Archived properties stay in SQLite with their history intact, but the dashboard
defaults to active rows and refresh-all skips archived rows. Delete is permanent
and relies on SQLite foreign-key cascades to remove history, events, and taxes.

AVM normalization picks the "best" current estimate from either of the two
shapes HomeHarvest returns: `raw["current_estimates"]` (flat snake_case) or
`raw["estimates"]["currentValues"]` (nested camelCase).

## Listing state logic

The Properties page uses `properties.listing_state`, normalized server-side from
the latest HomeHarvest/Realtor raw JSON. The dashboard buckets are:

1. `sold` — explicit current status text indicates `sold`/`closed`, and the
   sale date is no more than **180 days** old. This wins over stale
   `pending_date` values left on sold listings.
2. `pending` — `pending_date` exists, or Realtor/HomeHarvest status text
   contains `pending`, `contingent`, or `under contract`, unless the current
   status is already sold/closed.
3. `for_sale` — status text indicates `for_sale`, `active`, `coming soon`, or
   similar active listing state; as a fallback, a row with both `listing_id` and
   `list_price` is treated as for sale unless it has sold/closed cues.
4. `sold` — sale price/date exists without active or pending cues,
   and the sale date is no more than **180 days** old.
5. `off_market` — no active/pending signal, or a sold/closed signal whose sale
   date is older than 180 days.

The sold window is intentionally finite so old Realtor sold records do not stay
visually "Sold" forever on the Properties page. Change
`SOLD_TO_OFF_MARKET_DAYS` in `backend/app/scraper.py` if you want a different
threshold.

## Property timeline

The Property page is event-oriented:

- The chart renders Cotality and Quantarium as continuous AVM lines.
- Realtor listing/sale/price-change records render in the timeline and ownership
  history strip.
- The ownership-history strip zooms out across recorded sales while the chart
  focuses on the denser AVM period.
- The Timeline tab uses `Date`, `Event`, `Value`, and `Change` columns. Estimate
  rows keep low/high range inline with the estimate value; market rows show
  list/sale/price-change values independently.

Use **Backfill history** on a Property page to populate `historical_estimates`,
`property_events`, and `tax_history` for that property.

## Refresh jobs admin

The gear icon in the top bar opens the Refresh jobs page (`#admin`). It shows:

- latest sweep and active-property counts
- current properties with match/errors/no-candidate issues
- a recent manual job log stored in `localStorage`
- a cadence selector, defaulting to twice per month

The **Refresh all now** button calls `POST /api/properties/refresh-all` and then
reloads current property state. The cadence selector maps to the launchd install
command shown in the Schedule panel; it does not start background work inside
FastAPI.

## Scheduled refreshes

Scheduled refreshes are implemented as a macOS LaunchAgent that calls the
existing local API endpoint. Keep the HomeIndexr server running on the same
port used when installing the job.

```bash
./scripts/install_scheduled_refresh.py --cadence biweekly --port 5173
```

Supported cadences are `daily`, `weekly`, `biweekly`, `monthly`, and `manual`.
`manual` removes the installed LaunchAgent. `biweekly` runs on the 1st and 15th
of each month at 03:00 by default. To choose a time:

```bash
./scripts/install_scheduled_refresh.py --cadence weekly --time 08:30 --port 5173
```

To remove the LaunchAgent:

```bash
./scripts/install_scheduled_refresh.py --uninstall
# equivalent to:
./scripts/install_scheduled_refresh.py --cadence manual
```

The LaunchAgent writes stdout/stderr logs to `data/scheduled-refresh.out.log`
and `data/scheduled-refresh.err.log`.

## Auth

None. Local-only for v1. The frontend talks to the backend over plain HTTP,
and the backend has no user model — easy to bolt a session layer on top later
without disturbing storage.
