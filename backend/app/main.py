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

from . import scraper, store
from .db import init_db

ROOT = Path(__file__).resolve().parents[2]
FRONTEND_DIR = ROOT / "frontend"

app = FastAPI(title="HomeTracker")

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
    input_address: str | None = None
    canonical_address: str | None = None
    city: str | None = None
    state: str | None = None
    zip: str | None = None
    active: bool | None = None


@app.get("/api/properties")
def get_properties():
    return store.list_properties()


@app.get("/api/properties/{pid}")
def get_property(pid: int):
    p = store.get_property(pid)
    if not p:
        raise HTTPException(404, "property not found")
    p["historical"] = store.list_historical(pid)
    p["events"] = store.list_events(pid)
    p["tax_history"] = store.list_tax_history(pid)
    return p


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
    prop["historical"] = store.list_historical(pid)
    prop["events"] = store.list_events(pid)
    prop["tax_history"] = store.list_tax_history(pid)
    return prop


@app.post("/api/properties/{pid}/archive")
def archive_property(pid: int):
    prop = store.set_property_active(pid, False)
    if not prop:
        raise HTTPException(404, "property not found")
    prop["historical"] = store.list_historical(pid)
    prop["events"] = store.list_events(pid)
    prop["tax_history"] = store.list_tax_history(pid)
    return prop


@app.post("/api/properties/{pid}/restore")
def restore_property(pid: int):
    prop = store.set_property_active(pid, True)
    if not prop:
        raise HTTPException(404, "property not found")
    prop["historical"] = store.list_historical(pid)
    prop["events"] = store.list_events(pid)
    prop["tax_history"] = store.list_tax_history(pid)
    return prop


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
    if not prop.get("property_id"):
        return {"id": pid, "written": 0, "events_written": 0, "taxes_written": 0, "error": "no property_id on record"}
    try:
        bundle = scraper.fetch_history_bundle(prop["property_id"])
    except Exception as e:  # noqa: BLE001
        return {"id": pid, "written": 0, "events_written": 0, "taxes_written": 0, "error": f"{type(e).__name__}: {e}"}
    written = store.replace_historical(pid, bundle["estimates"])
    events_written = store.replace_events(pid, bundle["events"])
    taxes_written = store.replace_tax_history(pid, bundle.get("taxes", []))
    return {"id": pid, "written": written, "events_written": events_written, "taxes_written": taxes_written, "error": None}


@app.post("/api/properties/backfill-all")
def backfill_all():
    props = store.list_properties()
    results = []
    for p in props:
        if not p.get("property_id"):
            results.append({"id": p["id"], "written": 0, "events_written": 0, "taxes_written": 0, "error": "no property_id"})
            continue
        try:
            bundle = scraper.fetch_history_bundle(p["property_id"])
            written = store.replace_historical(p["id"], bundle["estimates"])
            events_written = store.replace_events(p["id"], bundle["events"])
            taxes_written = store.replace_tax_history(p["id"], bundle.get("taxes", []))
            results.append({"id": p["id"], "written": written, "events_written": events_written, "taxes_written": taxes_written, "error": None})
        except Exception as e:  # noqa: BLE001
            results.append({"id": p["id"], "written": 0, "events_written": 0, "taxes_written": 0, "error": f"{type(e).__name__}: {e}"})
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

    prop["historical"] = store.list_historical(prop["id"])
    prop["events"] = store.list_events(prop["id"])
    prop["tax_history"] = store.list_tax_history(prop["id"])
    return {"status": status, "property": prop, "candidate": None, "error": None}


@app.post("/api/properties/{pid}/refresh")
def refresh_property(pid: int):
    prop = store.get_property(pid)
    if not prop:
        raise HTTPException(404, "property not found")
    addr = prop["canonical_address"] or prop["input_address"]
    fetched = scraper.fetch(addr)
    store.update_property_meta(pid, fetched)
    out = store.get_property(pid)
    out["historical"] = store.list_historical(pid)
    out["events"] = store.list_events(pid)
    out["tax_history"] = store.list_tax_history(pid)
    return out


@app.post("/api/properties/refresh-all")
def refresh_all():
    props = [p for p in store.list_properties() if p.get("active") is not False]
    results = []
    for p in props:
        addr = p.get("canonical_address") or p["input_address"]
        fetched = scraper.fetch(addr)
        store.update_property_meta(p["id"], fetched)
        results.append({"id": p["id"], "status": fetched.get("status")})
    return {"refreshed": len(results), "results": results}


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
