# Add to HomeIndexr — Chrome extension

A toolbar popup that tracks the Zillow / Realtor.com property you're viewing in
your self-hosted HomeIndexr. It's a **thin client** over the existing backend —
it scrapes the listing's address from the page and hands it to
`POST /api/properties`, which does the real matching server-side (per the app's
rule that all Realtor scraping flows through `backend/app/scraper.py`).

This is a faithful build of the **"Add to HomeIndexr"** design prototype
(Option A, the toolbar popup), wired to the live API.

## Install (unpacked, dev)

1. Start HomeIndexr: `./run.sh` (serves `http://127.0.0.1:5173`).
2. Open `chrome://extensions`, enable **Developer mode**.
3. **Load unpacked** → select this `extension/` folder.
4. Visit a property page on **zillow.com** or **realtor.com** and click the
   HomeIndexr icon in the toolbar.

If your instance runs elsewhere, set the URL in the extension's **Options**
(right-click the icon → Options). Only `localhost` / `127.0.0.1` hosts work out
of the box — a different host needs a matching entry added to
`host_permissions` in `manifest.json`.

## How it works

- **Address extraction** runs on demand in the active tab via
  `chrome.scripting.executeScript` (the `activeTab` permission grants access the
  moment you click the icon — no always-on content script). It reads, in order:
  JSON-LD `PostalAddress`, `og:title` / `<h1>` / meta description (matched with a
  US-address regex), and finally the Realtor.com URL slug.
- **Networking** happens from the popup itself. The backend already sends
  permissive CORS (`allow_origins=["*"]`) and the manifest grants
  `host_permissions` for the local server, so no background worker is needed.
- The address is the only thing the backend needs; scraped beds/baths/sqft/price
  are best-effort and only used to enrich the preview.

### API used

| Call | Purpose |
|------|---------|
| `GET /api/properties` | reachability check + "already tracking" lookup (address matched case/whitespace-insensitively, mirroring `store._norm`) |
| `POST /api/properties {address, confirm_mismatch?}` | add the home; retried with `confirm_mismatch: true` when the user accepts a candidate |
| `GET /api/properties/{id}` | historical estimates → the tracking card's sparkline + "since first snapshot" delta |
| `POST /api/properties/{id}/refresh` | "Refresh now" on an already-tracked home |

## Popup states

`ready` · `saving` · `success` · `already tracking` · `couldn't match`
(candidate confirm) · `no match` · `upstream error` · `server offline` ·
`not a listing page`. Success / View property deep-links to the app's PDP at
`#property/<id>`.

## Not yet wired

The design's **tags & note** field is omitted: the backend has no column to
store them (`POST /api/properties` only accepts `address`). Add a `tags`/`note`
field server-side first, then surface it here.

## Files

- `manifest.json` — MV3 manifest (action popup, `activeTab`+`scripting`+`storage`, local host perms)
- `popup.html` / `popup.css` / `popup.js` — the popup UI + state machine
- `options.html` / `options.js` — server URL setting (`chrome.storage.sync`)
- `icons/` — toolbar icons generated from the HomeIndexr house+chart mark

No build step — plain HTML/CSS/JS, consistent with the app's no-build frontend.
