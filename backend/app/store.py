"""SQLite persistence helpers.

Each property stores the latest fetched HomeHarvest state directly on the
property row. Adding the same address never creates a duplicate property.
"""
from __future__ import annotations

import json
import re
import time
from typing import Any

from . import scraper
from .db import get_conn

PROPERTY_COLS = (
    "id input_address canonical_address city state zip property_id listing_id property_url "
    "listing_state active status matched_address best_current_estimate estimate_source "
    "estimate_low estimate_high estimate_date list_price sold_price last_sold_price "
    "beds baths sqft lot_sqft year_built latitude longitude raw_json error last_fetched_at "
    "created_at updated_at"
).split()


def _now() -> int:
    return int(time.time() * 1000)


def _norm(addr: str | None) -> str:
    return re.sub(r"\s+", " ", (addr or "")).strip().lower()


def _row_to_property(row: Any) -> dict:
    p = {k: row[k] for k in PROPERTY_COLS}
    p["active"] = bool(p["active"])
    if p.get("raw_json"):
        try:
            p["raw_json"] = json.loads(p["raw_json"])
        except (TypeError, ValueError):
            pass
    p["all_estimates"] = scraper.all_estimates(p["raw_json"]) if isinstance(p.get("raw_json"), dict) else []
    if isinstance(p.get("raw_json"), dict):
        p["listing_state"] = scraper.normalize_listing_state(p["raw_json"])
    return p


def _raw_json_for_db(fetched: dict) -> str | None:
    raw = fetched.get("raw_json")
    return json.dumps(raw, default=str) if raw is not None else None


def _current_values(fetched: dict, now: int) -> tuple:
    return (
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
        _raw_json_for_db(fetched),
        fetched.get("error"),
        now,
    )


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


def list_properties() -> list[dict]:
    """Return all properties with their current fetched HomeHarvest state."""
    with get_conn() as conn:
        return [
            _row_to_property(r)
            for r in conn.execute(
                "SELECT * FROM properties ORDER BY updated_at DESC"
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
                active, status,
                matched_address, best_current_estimate, estimate_source,
                estimate_low, estimate_high, estimate_date, list_price, sold_price,
                last_sold_price, beds, baths, sqft, lot_sqft, year_built,
                latitude, longitude, raw_json, error, last_fetched_at,
                created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
                *_current_values(fetched, now),
                now,
                now,
            ),
        )
        pid = cur.lastrowid
        row = conn.execute("SELECT * FROM properties WHERE id = ?", (pid,)).fetchone()
        return _row_to_property(row)


def update_property(property_id: int, changes: dict) -> dict | None:
    """Update user-managed property fields and return the updated row."""
    allowed = {"input_address", "canonical_address", "city", "state", "zip", "active"}
    updates = {k: v for k, v in changes.items() if k in allowed}
    if not updates:
        return get_property(property_id)

    now = _now()
    assignments = []
    values = []
    for key, value in updates.items():
        if key in {"input_address", "canonical_address", "city", "state", "zip"}:
            value = " ".join(str(value).split()) if value is not None else None
            if value == "":
                value = None
            if key == "state" and value:
                value = value.upper()
            if key == "input_address" and not value:
                raise ValueError("input_address is required")
        if key == "active":
            value = 1 if bool(value) else 0
        assignments.append(f"{key} = ?")
        values.append(value)

    assignments.append("updated_at = ?")
    values.extend([now, property_id])

    with get_conn() as conn:
        cur = conn.execute(
            f"UPDATE properties SET {', '.join(assignments)} WHERE id = ?",
            values,
        )
        if cur.rowcount == 0:
            return None
        row = conn.execute("SELECT * FROM properties WHERE id = ?", (property_id,)).fetchone()
        return _row_to_property(row) if row else None


def set_property_active(property_id: int, active: bool) -> dict | None:
    return update_property(property_id, {"active": active})


def delete_property(property_id: int) -> bool:
    with get_conn() as conn:
        cur = conn.execute("DELETE FROM properties WHERE id = ?", (property_id,))
        return cur.rowcount > 0


def update_property_meta(property_id: int, fetched: dict) -> None:
    """Refresh metadata and current fetched state on the property row."""
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
                 matched_address    = ?,
                 best_current_estimate = ?,
                 estimate_source    = ?,
                 estimate_low       = ?,
                 estimate_high      = ?,
                 estimate_date      = ?,
                 list_price         = ?,
                 sold_price         = ?,
                 last_sold_price    = ?,
                 beds               = ?,
                 baths              = ?,
                 sqft               = ?,
                 lot_sqft           = ?,
                 year_built         = ?,
                 latitude           = ?,
                 longitude          = ?,
                 raw_json           = ?,
                 error              = ?,
                 last_fetched_at    = ?,
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
                *_current_values(fetched, now),
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


def replace_events(property_id: int, records: list[dict]) -> int:
    """Upsert Realtor market events for a property. Returns rows written."""
    now = _now()
    rows = []
    seen = set()
    for r in records:
        date = r.get("date")
        event_name = r.get("event_name")
        price = r.get("price")
        if not date or not event_name or price is None:
            continue
        row = (property_id, str(date)[:10], str(event_name), int(price), now)
        key = row[:4]
        if key in seen:
            continue
        seen.add(key)
        rows.append(row)
    if not rows:
        return 0
    with get_conn() as conn:
        conn.executemany(
            "INSERT OR REPLACE INTO property_events "
            "(property_id, date, event_name, price, fetched_at) VALUES (?,?,?,?,?)",
            rows,
        )
    return len(rows)


def replace_tax_history(property_id: int, records: list[dict]) -> int:
    """Upsert Realtor tax history for a property. Returns rows written."""
    now = _now()
    rows = []
    seen = set()
    for r in records:
        year = r.get("year")
        if year is None:
            continue
        year = int(year)
        if year in seen:
            continue
        seen.add(year)
        rows.append((
            property_id,
            year,
            r.get("assessed_year"),
            r.get("tax"),
            r.get("assessment_building"),
            r.get("assessment_land"),
            r.get("assessment_total"),
            r.get("market_building"),
            r.get("market_land"),
            r.get("market_total"),
            r.get("appraisal_building"),
            r.get("appraisal_land"),
            r.get("appraisal_total"),
            r.get("value_building"),
            r.get("value_land"),
            r.get("value_total"),
            r.get("tax_code_area"),
            now,
        ))
    if not rows:
        return 0
    with get_conn() as conn:
        conn.executemany(
            """INSERT OR REPLACE INTO tax_history
               (property_id, year, assessed_year, tax,
                assessment_building, assessment_land, assessment_total,
                market_building, market_land, market_total,
                appraisal_building, appraisal_land, appraisal_total,
                value_building, value_land, value_total,
                tax_code_area, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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


def list_events(property_id: int) -> list[dict]:
    with get_conn() as conn:
        return [
            {"date": r["date"], "event_name": r["event_name"], "price": r["price"]}
            for r in conn.execute(
                "SELECT date, event_name, price FROM property_events "
                "WHERE property_id = ? ORDER BY date ASC, event_name ASC, price ASC",
                (property_id,),
            )
        ]


def list_tax_history(property_id: int) -> list[dict]:
    with get_conn() as conn:
        return [
            {
                "year": r["year"],
                "assessed_year": r["assessed_year"],
                "tax": r["tax"],
                "assessment_building": r["assessment_building"],
                "assessment_land": r["assessment_land"],
                "assessment_total": r["assessment_total"],
                "market_building": r["market_building"],
                "market_land": r["market_land"],
                "market_total": r["market_total"],
                "appraisal_building": r["appraisal_building"],
                "appraisal_land": r["appraisal_land"],
                "appraisal_total": r["appraisal_total"],
                "value_building": r["value_building"],
                "value_land": r["value_land"],
                "value_total": r["value_total"],
                "tax_code_area": r["tax_code_area"],
            }
            for r in conn.execute(
                """SELECT year, assessed_year, tax,
                          assessment_building, assessment_land, assessment_total,
                          market_building, market_land, market_total,
                          appraisal_building, appraisal_land, appraisal_total,
                          value_building, value_land, value_total,
                          tax_code_area
                   FROM tax_history
                   WHERE property_id = ?
                   ORDER BY year ASC""",
                (property_id,),
            )
        ]
