"""SQLite persistence helpers.

Snapshots are append-only. Adding the same address never creates a duplicate
property — it appends a snapshot to the existing one.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

from . import scraper
from .db import get_conn

SNAPSHOT_COLS = (
    "id property_id fetched_at status matched_address best_current_estimate "
    "estimate_source estimate_low estimate_high estimate_date list_price sold_price "
    "last_sold_price beds baths sqft lot_sqft year_built latitude longitude raw_json error"
).split()

PROPERTY_COLS = (
    "id input_address canonical_address city state zip property_id listing_id property_url "
    "listing_state active status created_at updated_at"
).split()


def _now() -> int:
    return int(time.time() * 1000)


def _norm(addr: str | None) -> str:
    return re.sub(r"\s+", " ", (addr or "")).strip().lower()


def _row_to_property(row: Any) -> dict:
    p = {k: row[k] for k in PROPERTY_COLS}
    p["active"] = bool(p["active"])
    return p


def _row_to_snapshot(row: Any) -> dict:
    s = {k: row[k] for k in SNAPSHOT_COLS}
    if s.get("raw_json"):
        try:
            s["raw_json"] = json.loads(s["raw_json"])
        except (TypeError, ValueError):
            pass
    s["all_estimates"] = scraper.all_estimates(s["raw_json"]) if isinstance(s.get("raw_json"), dict) else []
    return s


def find_property_by_address(input_address: str) -> dict | None:
    target = _norm(input_address)
    with get_conn() as conn:
        for row in conn.execute("SELECT * FROM properties"):
            cands = [row["canonical_address"], row["input_address"]]
            if any(_norm(c) == target for c in cands if c):
                return _row_to_property(row)
    return None


def get_property(property_id: int) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM properties WHERE id = ?", (property_id,)
        ).fetchone()
        return _row_to_property(row) if row else None


def list_properties_with_latest() -> list[dict]:
    """Return all properties; each carries a `snapshots` list containing only the latest snapshot."""
    with get_conn() as conn:
        props = [
            _row_to_property(r)
            for r in conn.execute(
                "SELECT * FROM properties ORDER BY updated_at DESC"
            )
        ]
        for p in props:
            row = conn.execute(
                "SELECT * FROM snapshots WHERE property_id = ? "
                "ORDER BY fetched_at DESC LIMIT 1",
                (p["id"],),
            ).fetchone()
            p["snapshots"] = [_row_to_snapshot(row)] if row else []
    return props


def list_snapshots(property_id: int) -> list[dict]:
    with get_conn() as conn:
        return [
            _row_to_snapshot(r)
            for r in conn.execute(
                "SELECT * FROM snapshots WHERE property_id = ? ORDER BY fetched_at ASC",
                (property_id,),
            )
        ]


def create_property(input_address: str, fetched: dict) -> dict:
    now = _now()
    canonical = fetched.get("matched_address") or input_address
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO properties
               (input_address, canonical_address, city, state, zip,
                property_id, listing_id, property_url, listing_state,
                active, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                input_address,
                canonical,
                fetched.get("city"),
                fetched.get("state"),
                fetched.get("zip"),
                fetched.get("property_id"),
                fetched.get("listing_id"),
                fetched.get("property_url"),
                fetched.get("listing_state"),
                1,
                fetched.get("status", "matched"),
                now,
                now,
            ),
        )
        pid = cur.lastrowid
        row = conn.execute("SELECT * FROM properties WHERE id = ?", (pid,)).fetchone()
        return _row_to_property(row)


def update_property_meta(property_id: int, fetched: dict) -> None:
    """Refresh light metadata on the property row from the latest snapshot."""
    now = _now()
    with get_conn() as conn:
        conn.execute(
            """UPDATE properties SET
                 canonical_address = COALESCE(?, canonical_address),
                 city               = COALESCE(?, city),
                 state              = COALESCE(?, state),
                 zip                = COALESCE(?, zip),
                 property_id        = COALESCE(?, property_id),
                 listing_id         = COALESCE(?, listing_id),
                 property_url       = COALESCE(?, property_url),
                 listing_state      = COALESCE(?, listing_state),
                 status             = ?,
                 updated_at         = ?
               WHERE id = ?""",
            (
                fetched.get("matched_address"),
                fetched.get("city"),
                fetched.get("state"),
                fetched.get("zip"),
                fetched.get("property_id"),
                fetched.get("listing_id"),
                fetched.get("property_url"),
                fetched.get("listing_state"),
                fetched.get("status", "matched"),
                now,
                property_id,
            ),
        )


def replace_historical(property_id: int, records: list[dict]) -> int:
    """Upsert historical estimates for a property. Returns rows written."""
    now = _now()
    rows = [
        (property_id, r["source"], r["date"], int(r["estimate"]), now)
        for r in records
        if r.get("source") and r.get("date") and r.get("estimate") is not None
    ]
    if not rows:
        return 0
    with get_conn() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO historical_estimates "
            "(property_id, source, date, estimate, fetched_at) VALUES (?,?,?,?,?)",
            rows,
        )
    return len(rows)


def list_historical(property_id: int) -> list[dict]:
    with get_conn() as conn:
        return [
            {"source": r["source"], "date": r["date"], "estimate": r["estimate"]}
            for r in conn.execute(
                "SELECT source, date, estimate FROM historical_estimates "
                "WHERE property_id = ? ORDER BY date ASC, source ASC",
                (property_id,),
            )
        ]


def insert_snapshot(property_id: int, fetched: dict) -> dict:
    now = _now()
    raw = fetched.get("raw_json")
    raw_str = json.dumps(raw, default=str) if raw is not None else None
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO snapshots
               (property_id, fetched_at, status, matched_address,
                best_current_estimate, estimate_source, estimate_low, estimate_high,
                estimate_date, list_price, sold_price, last_sold_price,
                beds, baths, sqft, lot_sqft, year_built,
                latitude, longitude, raw_json, error)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                property_id,
                now,
                fetched.get("status", "matched"),
                fetched.get("matched_address"),
                fetched.get("best_current_estimate"),
                fetched.get("estimate_source"),
                fetched.get("estimate_low"),
                fetched.get("estimate_high"),
                fetched.get("estimate_date"),
                fetched.get("list_price"),
                fetched.get("sold_price"),
                fetched.get("last_sold_price"),
                fetched.get("beds"),
                fetched.get("baths"),
                fetched.get("sqft"),
                fetched.get("lot_sqft"),
                fetched.get("year_built"),
                fetched.get("latitude"),
                fetched.get("longitude"),
                raw_str,
                fetched.get("error"),
            ),
        )
        sid = cur.lastrowid
        row = conn.execute("SELECT * FROM snapshots WHERE id = ?", (sid,)).fetchone()
        return _row_to_snapshot(row)
