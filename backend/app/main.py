from __future__ import annotations

from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

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


@app.get("/api/properties")
def get_properties():
    return store.list_properties_with_latest()


@app.get("/api/properties/{pid}")
def get_property(pid: int):
    p = store.get_property(pid)
    if not p:
        raise HTTPException(404, "property not found")
    p["snapshots"] = store.list_snapshots(pid)
    return p


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
        store.insert_snapshot(existing["id"], fetched)
        prop = store.get_property(existing["id"])
    else:
        prop = store.create_property(body.address, fetched)
        store.insert_snapshot(prop["id"], fetched)

    prop["snapshots"] = store.list_snapshots(prop["id"])
    return {"status": status, "property": prop, "candidate": None, "error": None}


@app.post("/api/properties/{pid}/refresh")
def refresh_property(pid: int):
    prop = store.get_property(pid)
    if not prop:
        raise HTTPException(404, "property not found")
    addr = prop["canonical_address"] or prop["input_address"]
    fetched = scraper.fetch(addr)
    if fetched.get("status") in ("matched", "candidate_mismatch"):
        store.update_property_meta(pid, fetched)
    store.insert_snapshot(pid, fetched)
    out = store.get_property(pid)
    out["snapshots"] = store.list_snapshots(pid)
    return out


@app.post("/api/properties/refresh-all")
def refresh_all():
    props = store.list_properties_with_latest()
    results = []
    for p in props:
        addr = p.get("canonical_address") or p["input_address"]
        fetched = scraper.fetch(addr)
        if fetched.get("status") in ("matched", "candidate_mismatch"):
            store.update_property_meta(p["id"], fetched)
        store.insert_snapshot(p["id"], fetched)
        results.append({"id": p["id"], "status": fetched.get("status")})
    return {"refreshed": len(results), "results": results}


# ---------- Static frontend ----------

if FRONTEND_DIR.exists():
    app.mount(
        "/static",
        StaticFiles(directory=str(FRONTEND_DIR)),
        name="static",
    )

    @app.get("/")
    def root() -> FileResponse:
        return FileResponse(FRONTEND_DIR / "index.html")
