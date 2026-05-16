# Handoff: HomeTracker Current-State Refactor

## Current state

- Repo: `/Users/cauchon/Projects/house-price-tracker`
- Branch: `codex/remove-snapshots`
- Dev server used for latest verification: `http://127.0.0.1:5181`
- Chrome was open at `http://127.0.0.1:5181/#property/1`.
- Ports `5173` and `5180` were already occupied during the latest verification,
  so the final browser check used `5181`.

## What changed in the current worktree

The app was refactored away from append-only fetch history. Each tracked
property now stores the current HomeHarvest state directly on the `properties`
row while historical Realtor AVMs and market events remain separate tables.

- Expanded `properties` to hold current estimate, range, list/sale fields,
  facts, coordinates, raw JSON, error, and `last_fetched_at`.
- Added startup migration that collapses the newest legacy fetch row into
  `properties`, then removes the old fetch-history table.
- `GET /api/properties/{id}` now returns `events` and `historical` with the
  property current state.
- Backfill routes now upsert AVM estimates, Realtor market events, and tax history.
- The Property detail chart keeps Cotality and Quantarium as continuous AVM
  lines from Realtor history plus the current fetch.
- An ownership-history strip under the chart zooms out across recorded sale
  events while highlighting the available estimate window.
- The Timeline tab is now event-shaped:
  - filters: `All`, `Estimates`, `Market events`, `Issues`
  - columns: `Date`, `Event`, `Value`, `Change`
  - estimate rows keep low/high range inline with the estimate value
  - Realtor event rows such as `Listed`, `Sold`, `Price Changed`, `Relisted`,
    and `Listing removed` are separate rows
- The table no longer repeats `List`/`Sold` columns on every estimate row.
- The old horizontal latest-list-price chart line was removed.
- `README.md` and `AGENTS.md` were updated to document current-state property
  storage, historical AVMs, market events, backfill routes, and the event-shaped
  Property timeline.

Modified files:

- `backend/app/db.py`
- `backend/app/scraper.py`
- `backend/app/store.py`
- `backend/app/main.py`
- `frontend/chart.jsx`
- `frontend/pages.jsx`
- `frontend/styles.css`
- `README.md`
- `AGENTS.md`
- `HANDOFF.md`

## Verification already done

Commands/checks run:

```bash
.venv312/bin/python -m py_compile backend/app/db.py backend/app/scraper.py backend/app/store.py backend/app/main.py
```

Temp DB smoke test:

- Created a temp DB with a mocked `fetch_history_bundle`.
- Verified `backfill_property()` writes historical estimates and events.
- Verified duplicate event input remains deduped in stored detail response.

Live local API verification against `5180`:

```bash
curl -s -X POST http://127.0.0.1:5180/api/properties/1/backfill
curl -s http://127.0.0.1:5180/api/properties/1
```

Observed:

- Property `1` backfill returned `written: 122`, `events_written: 9`.
- Re-running backfill still left `9` event rows for property `1`.
- `property_events` contains rows including:
  - `2023-04-07 | Sold | 585000`
  - `2015-02-27 | Sold | 354000`
  - `2014-12-16 | Price Changed | 349950`
  - `2014-11-21 | Price Changed | 364900`
  - `2014-11-01 | Price Changed | 369900`

Rendered browser verification:

- Page loaded at `http://127.0.0.1:5181/#property/1`.
- Timeline tab rendered with `DATE EVENT VALUE CHANGE`.
- Chart legend showed Cotality, Quantarium, Listed, Sold, Price change.
- Ownership history strip rendered recorded sale markers and the tracked-estimate
  window.
- DOM text confirmed market event rows exist, including `Sold`, `Relisted`,
  `Listing removed`, and event prices.
- The `Market events` filter reduced the timeline to 9 Realtor events.
- Estimate breakdown source toggle still worked.
- Console warnings were only Babel standalone warnings, expected for this no-build frontend.

Older screenshots from the first historical-events verification were saved
outside the repo:

- `/private/tmp/hpt-events-desktop.jpg`
- `/private/tmp/hpt-events-mobile.jpg`

## Design handoff consumed

The Anthropic design artifact was fetched and unpacked from:

```text
https://api.anthropic.com/v1/design/h/WsCBQzHEhH5UOvpGSVrJPQ?open_file=HomeTracker.html
```

Read before implementation:

- `hometracker/README.md`
- `hometracker/chats/chat1.md`
- `hometracker/chats/chat2.md`
- `hometracker/project/HomeTracker.html`
- imported project files including `pages-detail.jsx`, `chart.jsx`,
  `components.jsx`, `data.js`, and `styles.css`

The design request is now implemented; future work should treat the current
codebase and docs as the source of truth.

## Known caveats

- This repo is a no-build React app using UMD React and Babel standalone.
- New frontend files must be registered in `frontend/index.html` with `type="text/babel"` and must expose needed globals on `window`.
- `data/app.db` is local state and was mutated by live backfill verification.
- `tax_history` is now in scope for backfill and renders in the Property detail Taxes tab.
- FastAPI `TestClient` was not usable because optional dependency `httpx` is not installed.
- The app normally uses port `5173`, but recent runs used alternate ports
  because `5173` was occupied.
