from __future__ import annotations

import sqlite3
from pathlib import Path

import re

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.types import Scope

from . import ai, browse, comps, scraper, store
from .db import init_db

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT / "frontend"

app = FastAPI(title="HomeIndexr")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("startup")
def _startup() -> None:
    init_db()


# ---------- API ----------


class AddBody(BaseModel):
    address: str
    confirm_mismatch: bool = False


class UpdatePropertyBody(BaseModel):
    property_name: str | None = None
    input_address: str | None = None
    canonical_address: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    active: bool | None = None
    pinned: bool | None = None


class AISettingsBody(BaseModel):
    enabled: bool | None = None


class AIQuestionBody(BaseModel):
    question: str


class AddZipBody(BaseModel):
    zip: str


class AreaStatusBody(BaseModel):
    status: str


ZIP_RE = re.compile(r"^\d{5}$")


@app.get("/api/properties")
def get_properties():
    return store.list_properties()


@app.get("/api/admin/ai-settings")
def get_ai_settings():
    return store.get_ai_settings()


@app.patch("/api/admin/ai-settings")
def update_ai_settings(body: AISettingsBody):
    changes = body.model_dump(exclude_unset=True)
    return store.save_ai_settings(**changes)


def _property_with_related(pid: int) -> dict | None:
    prop = store.get_property(pid)
    if not prop:
        return None
    prop["historical"] = store.list_historical(pid)
    prop["events"] = store.list_events(pid)
    prop["tax_history"] = store.list_tax_history(pid)
    prop["schools"] = store.list_schools(pid)
    prop["photos"] = scraper.extract_photos(prop.get("raw_json"))
    return prop


def _backfill_history(pid: int, property_id: str | None) -> dict:
    if not property_id:
        return {
            "id": pid,
            "written": 0,
            "events_written": 0,
            "taxes_written": 0,
            "error": "no property_id on record",
        }
    try:
        bundle = scraper.fetch_history_bundle(property_id)
    except Exception as e:  # noqa: BLE001
        return {
            "id": pid,
            "written": 0,
            "events_written": 0,
            "taxes_written": 0,
            "error": f"{type(e).__name__}: {e}",
        }
    written = store.replace_historical(pid, bundle["estimates"])
    events_written = store.replace_events(pid, bundle["events"])
    taxes_written = store.replace_tax_history(pid, bundle.get("taxes", []))
    return {
        "id": pid,
        "written": written,
        "events_written": events_written,
        "taxes_written": taxes_written,
        "error": None,
    }


@app.get("/api/properties/{pid}")
def get_property(pid: int):
    p = _property_with_related(pid)
    if not p:
        raise HTTPException(404, "property not found")
    return p


@app.post("/api/properties/{pid}/ai/ask")
def ask_property_ai(pid: int, body: AIQuestionBody):
    question = body.question.strip()
    if not question:
        raise HTTPException(400, "question is required")
    settings = store.get_ai_settings()
    if not settings["enabled"]:
        raise HTTPException(403, "AI features are disabled")
    if not settings["has_deepseek_api_key"]:
        raise HTTPException(400, "DEEPSEEK_API_KEY is not configured")
    prop = _property_with_related(pid)
    if not prop:
        raise HTTPException(404, "property not found")
    try:
        return ai.answer_property_question(prop, question)
    except ai.AIError as e:
        raise HTTPException(502, str(e)) from e


@app.patch("/api/properties/{pid}")
def update_property(pid: int, body: UpdatePropertyBody):
    changes = body.dict(exclude_unset=True)
    if not changes:
        prop = store.get_property(pid)
        if not prop:
            raise HTTPException(404, "property not found")
        return prop
    try:
        prop = store.update_property(pid, changes)
    except ValueError as e:
        raise HTTPException(400, str(e)) from e
    except sqlite3.IntegrityError as e:
        raise HTTPException(409, "another property already uses that canonical address") from e
    if not prop:
        raise HTTPException(404, "property not found")
    return _property_with_related(pid)


@app.post("/api/properties/{pid}/archive")
def archive_property(pid: int):
    prop = store.set_property_active(pid, False)
    if not prop:
        raise HTTPException(404, "property not found")
    return _property_with_related(pid)


@app.post("/api/properties/{pid}/restore")
def restore_property(pid: int):
    prop = store.set_property_active(pid, True)
    if not prop:
        raise HTTPException(404, "property not found")
    return _property_with_related(pid)


@app.delete("/api/properties/{pid}")
def delete_property(pid: int):
    deleted = store.delete_property(pid)
    if not deleted:
        raise HTTPException(404, "property not found")
    return {"deleted": True, "id": pid}


@app.post("/api/properties/{pid}/backfill")
def backfill_property(pid: int):
    prop = store.get_property(pid)
    if not prop:
        raise HTTPException(404, "property not found")
    return _backfill_history(pid, prop.get("property_id"))


@app.post("/api/properties/backfill-all")
def backfill_all():
    props = store.list_properties()
    results = []
    for p in props:
        results.append(_backfill_history(p["id"], p.get("property_id")))
    return {"backfilled": sum(1 for r in results if r["error"] is None), "results": results}


@app.post("/api/properties")
def add_property(body: AddBody):
    fetched = scraper.fetch(body.address)
    status = fetched.get("status")

    if status == "error":
        return {"status": "error", "error": fetched.get("error"), "property": None, "candidate": None}
    if status == "no_candidates":
        return {"status": "no_candidates", "error": None, "property": None, "candidate": None}

    existing = store.find_property_by_address(body.address)
    if not existing and fetched.get("matched_address"):
        existing = store.find_property_by_address(fetched["matched_address"])

    if status == "candidate_mismatch" and not body.confirm_mismatch and not existing:
        return {
            "status": "candidate_mismatch",
            "property": None,
            "candidate": {
                "input_address": body.address,
                "matched_address": fetched.get("matched_address"),
                "best_current_estimate": fetched.get("best_current_estimate"),
                "estimate_source": fetched.get("estimate_source"),
                "estimate_low": fetched.get("estimate_low"),
                "estimate_high": fetched.get("estimate_high"),
                "list_price": fetched.get("list_price"),
                "listing_state": fetched.get("listing_state"),
                "beds": fetched.get("beds"),
                "baths": fetched.get("baths"),
                "sqft": fetched.get("sqft"),
                "year_built": fetched.get("year_built"),
            },
            "error": None,
        }

    if existing:
        store.update_property_meta(existing["id"], fetched)
        store.set_property_active(existing["id"], True)
        prop = store.get_property(existing["id"])
    else:
        prop = store.create_property(body.address, fetched)

    backfill = _backfill_history(prop["id"], prop.get("property_id"))
    prop = _property_with_related(prop["id"])
    if prop.get("zip"):
        store.refresh_area_for_zip(prop["zip"])
    return {"status": status, "property": prop, "candidate": None, "error": None, "backfill": backfill}


@app.get("/api/properties/{pid}/area")
def get_property_area(
    pid: int,
    min_price: float | None = None,
    max_price: float | None = None,
    min_beds: float | None = None,
    min_baths: float | None = None,
    min_sqft: float | None = None,
    max_sqft: float | None = None,
):
    """Comparable for-sale homes in this property's ZIP. Reads the per-ZIP cache
    only (never calls Realtor; populated by property refresh), excludes the
    subject property, then gates + ranks the rest into appraisal-style comps.

    The optional filter params (min/max price + sqft, min beds + baths) narrow
    the candidate pool *before* ranking, so the returned page is the best comps
    that are both appraisal-comparable and in-filter — drawn from the whole
    cached pool, not just a pre-narrowed page. `domain` describes the unfiltered
    comp spread so the UI's sliders stay stable across filter changes."""
    prop = store.get_property(pid)
    if not prop:
        raise HTTPException(404, "property not found")
    zip_code = prop.get("zip")
    if not zip_code:
        return {"zip": None, "fetched_at": None, "comps": [], "relaxed": None,
                "limited": False, "subject_price_per_sqft": None,
                "domain": {"prices": [], "sqfts": [], "count": 0}}
    area = store.get_area_listings(zip_code)
    subject = str(prop.get("property_id") or "")
    candidates = [
        l for l in area["listings"] if str(l.get("property_id") or "") != subject
    ]
    filters = {
        "min_price": min_price, "max_price": max_price,
        "min_beds": min_beds, "min_baths": min_baths,
        "min_sqft": min_sqft, "max_sqft": max_sqft,
    }
    ranked = comps.rank_comparables(prop, candidates, filters=filters)
    return {
        "zip": area["zip"],
        "fetched_at": area["fetched_at"],
        "comps": ranked["comps"],
        "relaxed": ranked["relaxed"],
        "limited": ranked["limited"],
        "subject_price_per_sqft": ranked["subject_price_per_sqft"],
        "domain": comps.comp_domain(prop, candidates),
    }


@app.get("/api/browse")
def get_browse():
    """Cache-only Browse pool: every for-sale home across the per-ZIP area cache,
    deduped, with homes you already track removed. Never calls Realtor — the cache
    is populated by property refresh (rule #14), so opening Browse adds no upstream
    traffic. Filtering and sorting happen client-side over the whole pool; `bounds`
    + `price_hist` give the filter sliders a stable span, `total` the pool size,
    and `zips`/`cities` describe which areas the pool spans."""
    # Paused ZIPs keep their crawled index but drop out of the Browse pool
    # (Tracked areas → pause). Everything else unions as usual (rule #16).
    area_rows = [
        r for r in store.get_all_area_listings() if r.get("status") != "paused"
    ]
    tracked_ids = {
        str(p.get("property_id"))
        for p in store.list_properties()
        if p.get("property_id")
    }
    pool = browse.build_pool(area_rows, tracked_ids)
    facets = browse.pool_facets(pool["homes"])
    return {
        "homes": pool["homes"],
        "total": facets["count"],
        "zips": pool["zips"],
        "fetched_at": pool["fetched_at"],
        "cities": facets["cities"],
        "statuses": facets["statuses"],
        "bounds": facets["bounds"],
        "price_hist": facets["price_hist"],
    }


# ---------- Tracked areas (Browse coverage) ----------
# The ZIP codes we've crawled from Realtor.com — the pool Browse draws from.
# A ZIP enters this set either automatically (adding/refreshing a property
# crawls its whole ZIP, rule #14) or manually here. Listed/added/re-crawled/
# paused/removed from Admin → Tracked areas.


def _area_record(zip_code: str) -> dict | None:
    return next(
        (r for r in store.list_area_coverage() if r["zip"] == zip_code), None
    )


@app.get("/api/admin/areas")
def list_areas():
    return store.list_area_coverage()


@app.post("/api/admin/areas")
def add_area(body: AddZipBody):
    """Add a ZIP and crawl it once from Realtor.com (user-initiated; rule #14).

    Synchronous: the crawl runs server-side (rule #1) before the response, so the
    caller gets the real indexed-home count back. Rejects malformed or
    already-tracked ZIPs and surfaces an upstream failure as a 502."""
    zip_code = (body.zip or "").strip()
    if not ZIP_RE.match(zip_code):
        raise HTTPException(400, "Enter a full 5-digit ZIP code")
    if store.area_zip_exists(zip_code):
        raise HTTPException(409, f"{zip_code} is already tracked")
    try:
        store.crawl_area_zip(zip_code)
    except Exception as e:  # noqa: BLE001 — report the crawl failure to the user
        raise HTTPException(502, f"Couldn't crawl {zip_code}: {e}") from e
    return _area_record(zip_code)


@app.post("/api/admin/areas/{zip_code}/recrawl")
def recrawl_area(zip_code: str):
    """Re-run the one-time SRP crawl for an already-tracked ZIP (rule #14)."""
    zip_code = (zip_code or "").strip()
    if not store.area_zip_exists(zip_code):
        raise HTTPException(404, "ZIP is not tracked")
    try:
        store.crawl_area_zip(zip_code)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Couldn't re-crawl {zip_code}: {e}") from e
    return _area_record(zip_code)


@app.patch("/api/admin/areas/{zip_code}")
def update_area(zip_code: str, body: AreaStatusBody):
    """Pause/resume a tracked ZIP. Paused ZIPs keep their index but drop from
    Browse (the index stays so resume is instant)."""
    zip_code = (zip_code or "").strip()
    if body.status not in ("active", "paused"):
        raise HTTPException(400, "status must be 'active' or 'paused'")
    if not store.set_area_status(zip_code, body.status):
        raise HTTPException(404, "ZIP is not tracked")
    return _area_record(zip_code)


@app.delete("/api/admin/areas/{zip_code}")
def remove_area(zip_code: str):
    """Drop a ZIP's crawled index. A ZIP backing an active tracked property is
    locked (delete that property first); tracked properties are never touched."""
    zip_code = (zip_code or "").strip()
    record = _area_record(zip_code)
    if not record:
        raise HTTPException(404, "ZIP is not tracked")
    if record["locked"]:
        raise HTTPException(
            409,
            "This ZIP backs a property you track — remove that property first",
        )
    store.delete_area_listings(zip_code)
    return {"ok": True, "zip": zip_code}


@app.post("/api/properties/{pid}/refresh")
def refresh_property(pid: int):
    prop = store.get_property(pid)
    if not prop:
        raise HTTPException(404, "property not found")
    addr = prop["canonical_address"] or prop["input_address"]
    fetched = scraper.fetch(addr)
    store.update_property_meta(pid, fetched)
    zip_code = fetched.get("zip") or prop.get("zip")
    if zip_code:
        store.refresh_area_for_zip(zip_code)
    return _property_with_related(pid)


@app.post("/api/properties/refresh-all")
def refresh_all():
    props = [p for p in store.list_properties() if p.get("active") is not False]
    results = []
    zips: set[str] = set()
    for p in props:
        addr = p.get("canonical_address") or p["input_address"]
        fetched = scraper.fetch(addr)
        observed_event = store.update_property_meta(p["id"], fetched)
        zip_code = fetched.get("zip") or p.get("zip")
        if zip_code:
            zips.add(zip_code)
        results.append({"id": p["id"], "status": store.persisted_status(fetched), "observed_event": observed_event})
    # One area fetch per unique ZIP, not per property.
    for zip_code in zips:
        store.refresh_area_for_zip(zip_code)
    return {"refreshed": len(results), "results": results, "areas_refreshed": len(zips)}


# ---------- Static frontend ----------

class NoCacheStaticFiles(StaticFiles):
    """Dev-friendly: tell browsers not to cache so edits show up immediately."""

    async def get_response(self, path: str, scope: Scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
        return response


if FRONTEND_DIR.exists():
    app.mount(
        "/static",
        NoCacheStaticFiles(directory=str(FRONTEND_DIR)),
        name="static",
    )

    @app.get("/")
    def root() -> HTMLResponse:
        """Serve index.html with cache-buster query params appended to /static/* URLs.

        Uses each file's mtime so edits invalidate the script URL itself, which
        bypasses any stale entries already sitting in the browser cache.
        """
        html = (FRONTEND_DIR / "index.html").read_text()

        def _bust(match: re.Match[str]) -> str:
            attr, full_path = match.group(1), match.group(2)
            rel = full_path[len("/static/"):]
            try:
                mtime = int((FRONTEND_DIR / rel).stat().st_mtime)
            except OSError:
                mtime = 0
            return f'{attr}="{full_path}?v={mtime}"'

        html = re.sub(r'(src|href)="(/static/[^"?]+)"', _bust, html)
        return HTMLResponse(
            html,
            headers={"Cache-Control": "no-cache, no-store, must-revalidate"},
        )
