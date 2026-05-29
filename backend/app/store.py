"""SQLite persistence helpers.

Each property stores the latest fetched Realtor.com state directly on the
property row. Adding the same address never creates a duplicate property.
"""
from __future__ import annotations

import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import scraper
from .db import ROOT, get_conn

PROPERTY_COLS = (
    "id property_name input_address canonical_address city state zip property_id listing_id property_url "
    "listing_state active status matched_address best_current_estimate estimate_source "
    "estimate_low estimate_high estimate_date list_price sold_price last_sold_price "
    "beds baths sqft lot_sqft year_built latitude longitude "
    "list_date days_on_market last_price_change_amount last_price_change_date hoa_fee "
    "property_type property_sub_type stories garage garage_type "
    "pool cooling heating fireplace "
    "is_new_listing is_price_reduced is_foreclosure "
    "flood_factor_score flood_factor_severity "
    "raw_json error last_fetched_at pinned created_at updated_at"
).split()

CURRENT_FIELDS = (
    "matched_address best_current_estimate estimate_source "
    "estimate_low estimate_high estimate_date list_price sold_price last_sold_price "
    "beds baths sqft lot_sqft year_built latitude longitude "
    "list_date days_on_market last_price_change_amount last_price_change_date hoa_fee "
    "property_type property_sub_type stories garage garage_type "
    "pool cooling heating fireplace "
    "is_new_listing is_price_reduced is_foreclosure "
    "flood_factor_score flood_factor_severity"
).split()


def _now() -> int:
    return int(time.time() * 1000)


def _norm(addr: str | None) -> str:
    return re.sub(r"\s+", " ", (addr or "")).strip().lower()


def _row_to_property(row: Any) -> dict:
    p = {k: row[k] for k in PROPERTY_COLS}
    p["active"] = bool(p["active"])
    p["pinned"] = bool(p["pinned"])
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


def _dotenv_path() -> Path:
    return Path(os.environ.get("HOMEINDEXR_DOTENV_PATH") or ROOT / ".env")


def _dotenv_value(name: str) -> str | None:
    try:
        lines = _dotenv_path().read_text().splitlines()
    except OSError:
        return None
    for line in lines:
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        if key.strip() != name:
            continue
        value = value.strip().strip("\"'")
        return value or None
    return None


def _deepseek_key_source() -> str | None:
    if os.environ.get("DEEPSEEK_API_KEY"):
        return "environment"
    if _dotenv_value("DEEPSEEK_API_KEY"):
        return "dotenv"
    return None


def get_deepseek_api_key() -> str | None:
    return os.environ.get("DEEPSEEK_API_KEY") or _dotenv_value("DEEPSEEK_API_KEY")


def get_deepseek_model() -> str:
    return os.environ.get("DEEPSEEK_MODEL") or _dotenv_value("DEEPSEEK_MODEL") or "deepseek-v4-flash"


def get_deepseek_api_base() -> str:
    return (os.environ.get("DEEPSEEK_API_BASE") or _dotenv_value("DEEPSEEK_API_BASE") or "https://api.deepseek.com").rstrip("/")


def _brave_key_source() -> str | None:
    if os.environ.get("BRAVE_API_KEY"):
        return "environment"
    if _dotenv_value("BRAVE_API_KEY"):
        return "dotenv"
    return None


def get_brave_api_key() -> str | None:
    """Brave Search API key, used to give the AI a web_search tool. Optional."""
    return os.environ.get("BRAVE_API_KEY") or _dotenv_value("BRAVE_API_KEY")


def get_brave_api_base() -> str:
    return (
        os.environ.get("BRAVE_API_BASE")
        or _dotenv_value("BRAVE_API_BASE")
        or "https://api.search.brave.com/res/v1"
    ).rstrip("/")


def get_geocoder_base() -> str:
    """Nominatim-compatible geocoding endpoint. No key required."""
    return (
        os.environ.get("GEOCODER_BASE")
        or _dotenv_value("GEOCODER_BASE")
        or "https://nominatim.openstreetmap.org"
    ).rstrip("/")


def get_geocoder_user_agent() -> str:
    return (
        os.environ.get("GEOCODER_USER_AGENT")
        or _dotenv_value("GEOCODER_USER_AGENT")
        or "HomeIndexr/1.0 (local property research)"
    )


def _date_from_ms(ms: int | None) -> str | None:
    if ms is None:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).date().isoformat()


def _event_sort_ms(event: dict) -> int:
    if event.get("observed_at") is not None:
        return int(event["observed_at"])
    try:
        return int(datetime.fromisoformat(str(event.get("date"))[:10]).replace(tzinfo=timezone.utc).timestamp() * 1000)
    except (TypeError, ValueError):
        return 0


def _current_values(fetched: dict, now: int) -> tuple:
    """Values for the CURRENT_FIELDS columns plus raw_json, error, last_fetched_at."""
    base = tuple(fetched.get(k) for k in CURRENT_FIELDS)
    return base + (_raw_json_for_db(fetched), fetched.get("error"), now)


_CURRENT_COL_LIST = ", ".join(CURRENT_FIELDS + ["raw_json", "error", "last_fetched_at"])
_CURRENT_PLACEHOLDERS = ", ".join(["?"] * (len(CURRENT_FIELDS) + 3))
_CURRENT_ASSIGNMENTS = ", ".join(f"{c} = ?" for c in CURRENT_FIELDS + ["raw_json", "error", "last_fetched_at"])
_ACTIVE_LISTING_STATES = {"for_sale", "pending"}


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
    """Return all properties with their current fetched Realtor.com state."""
    with get_conn() as conn:
        return [
            _row_to_property(r)
            for r in conn.execute(
                "SELECT * FROM properties ORDER BY updated_at DESC"
            )
        ]


def get_ai_settings() -> dict:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT key, value FROM app_settings WHERE key = 'ai_enabled'"
        ).fetchall()
    values = {row["key"]: row["value"] for row in rows}
    key_source = _deepseek_key_source()
    brave_source = _brave_key_source()
    return {
        "enabled": values.get("ai_enabled") == "1",
        "provider": "deepseek",
        "has_deepseek_api_key": key_source is not None,
        "deepseek_api_key_source": key_source,
        "deepseek_api_key_env_var": "DEEPSEEK_API_KEY",
        # Optional web_search tool. Geocoding tools need no key, so they are
        # always available whenever AI is enabled.
        "has_brave_api_key": brave_source is not None,
        "brave_api_key_source": brave_source,
        "brave_api_key_env_var": "BRAVE_API_KEY",
    }


def save_ai_settings(
    *,
    enabled: bool | None = None,
) -> dict:
    now = _now()
    with get_conn() as conn:
        conn.execute("DELETE FROM app_settings WHERE key = 'deepseek_api_key'")
        if enabled is not None:
            conn.execute(
                """INSERT INTO app_settings (key, value, updated_at)
                   VALUES ('ai_enabled', ?, ?)
                   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at""",
                ("1" if enabled else "0", now),
            )
    return get_ai_settings()


def create_property(input_address: str, fetched: dict) -> dict:
    now = _now()
    canonical = fetched.get("matched_address") or input_address
    with get_conn() as conn:
        cur = conn.execute(
            f"""INSERT INTO properties
                (input_address, canonical_address, city, state, zip,
                 property_id, listing_id, property_url, listing_state,
                 active, status,
                 {_CURRENT_COL_LIST},
                 created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,{_CURRENT_PLACEHOLDERS},?,?)""",
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
    replace_schools(pid, fetched.get("schools") or [])
    return get_property(pid)


def update_property(property_id: int, changes: dict) -> dict | None:
    """Update user-managed property fields and return the updated row."""
    allowed = {"property_name", "input_address", "canonical_address", "city", "state", "zip", "active", "pinned"}
    updates = {k: v for k, v in changes.items() if k in allowed}
    if not updates:
        return get_property(property_id)

    now = _now()
    assignments = []
    values = []
    for key, value in updates.items():
        if key in {"property_name", "input_address", "canonical_address", "city", "state", "zip"}:
            value = " ".join(str(value).split()) if value is not None else None
            if value == "":
                value = None
            if key == "state" and value:
                value = value.upper()
            if key == "input_address" and not value:
                raise ValueError("input_address is required")
        if key == "active":
            value = 1 if bool(value) else 0
        if key == "pinned":
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


def _observed_list_price_event(previous: Any, fetched: dict, now: int) -> dict | None:
    old_price = previous["list_price"]
    new_price = fetched.get("list_price")
    if old_price is None or new_price is None:
        return None

    old_price = int(old_price)
    new_price = int(new_price)
    if old_price == new_price:
        return None

    old_state = previous["listing_state"]
    new_state = fetched.get("listing_state")
    if old_state not in _ACTIVE_LISTING_STATES or new_state not in _ACTIVE_LISTING_STATES:
        return None

    old_listing_id = previous["listing_id"]
    new_listing_id = fetched.get("listing_id") or old_listing_id
    if old_listing_id and new_listing_id and old_listing_id != new_listing_id:
        return None

    delta = new_price - old_price
    return {
        "property_id": previous["id"],
        "observed_at": now,
        "date": _date_from_ms(now),
        "event_name": "Price dropped" if delta < 0 else "Price increased",
        "source": "observed",
        "listing_state": new_state,
        "listing_id": new_listing_id,
        "old_price": old_price,
        "new_price": new_price,
        "price": new_price,
        "delta": delta,
        "pct": delta / old_price if old_price else None,
    }


def _insert_observed_event(conn: Any, event: dict) -> dict | None:
    cur = conn.execute(
        """INSERT OR IGNORE INTO observed_events
           (property_id, observed_at, event_name, source, listing_state, listing_id,
            old_price, new_price, price, delta, pct)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
        (
            event["property_id"],
            event["observed_at"],
            event["event_name"],
            "refresh",
            event.get("listing_state"),
            event.get("listing_id"),
            event.get("old_price"),
            event.get("new_price"),
            event["price"],
            event.get("delta"),
            event.get("pct"),
        ),
    )
    return event if cur.rowcount else None


def update_property_meta(property_id: int, fetched: dict) -> dict | None:
    """Refresh metadata/current fetched state and record observed price changes."""
    now = _now()
    observed_event = None
    with get_conn() as conn:
        previous = conn.execute(
            "SELECT id, listing_state, listing_id, list_price FROM properties WHERE id = ?",
            (property_id,),
        ).fetchone()
        if previous and fetched.get("status", "matched") == "matched":
            observed_event = _observed_list_price_event(previous, fetched, now)
            if observed_event:
                observed_event = _insert_observed_event(conn, observed_event)

        conn.execute(
            f"""UPDATE properties SET
                  canonical_address = COALESCE(?, canonical_address),
                  city               = COALESCE(?, city),
                  state              = COALESCE(?, state),
                  zip                = COALESCE(?, zip),
                  property_id        = COALESCE(?, property_id),
                  listing_id         = COALESCE(?, listing_id),
                  property_url       = COALESCE(?, property_url),
                  listing_state      = COALESCE(?, listing_state),
                  status             = ?,
                  {_CURRENT_ASSIGNMENTS},
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
    replace_schools(property_id, fetched.get("schools") or [])
    return observed_event


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
        realtor_events = [
            {
                "date": r["date"],
                "event_name": r["event_name"],
                "price": r["price"],
                "source": "realtor",
            }
            for r in conn.execute(
                "SELECT date, event_name, price FROM property_events WHERE property_id = ?",
                (property_id,),
            )
        ]
        observed_events = [
            {
                "date": _date_from_ms(r["observed_at"]),
                "event_name": r["event_name"],
                "price": r["price"],
                "source": "observed",
                "observed_at": r["observed_at"],
                "old_price": r["old_price"],
                "new_price": r["new_price"],
                "delta": r["delta"],
                "pct": r["pct"],
            }
            for r in conn.execute(
                """SELECT observed_at, event_name, price, old_price, new_price, delta, pct
                   FROM observed_events
                   WHERE property_id = ?""",
                (property_id,),
            )
        ]
    return sorted(
        realtor_events + observed_events,
        key=lambda e: (_event_sort_ms(e), e.get("event_name") or "", e.get("price") or 0),
    )


def replace_schools(property_id: int, records: list[dict]) -> int:
    """Replace the schools list for a property. Returns rows written."""
    now = _now()
    rows = []
    seen: set[str] = set()
    for r in records or []:
        sid = r.get("school_id")
        name = r.get("name")
        if not sid or not name or sid in seen:
            continue
        seen.add(sid)
        rows.append((
            property_id,
            sid,
            name,
            r.get("rating"),
            r.get("grades"),
            r.get("education_levels"),
            r.get("funding_type"),
            r.get("distance_in_miles"),
            r.get("student_count"),
            now,
        ))
    with get_conn() as conn:
        conn.execute("DELETE FROM property_schools WHERE property_id = ?", (property_id,))
        if rows:
            conn.executemany(
                """INSERT INTO property_schools
                   (property_id, school_id, name, rating, grades, education_levels,
                    funding_type, distance_in_miles, student_count, fetched_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                rows,
            )
    return len(rows)


def list_schools(property_id: int) -> list[dict]:
    with get_conn() as conn:
        return [
            {
                "school_id": r["school_id"],
                "name": r["name"],
                "rating": r["rating"],
                "grades": r["grades"],
                "education_levels": r["education_levels"],
                "funding_type": r["funding_type"],
                "distance_in_miles": r["distance_in_miles"],
                "student_count": r["student_count"],
            }
            for r in conn.execute(
                """SELECT school_id, name, rating, grades, education_levels,
                          funding_type, distance_in_miles, student_count
                   FROM property_schools
                   WHERE property_id = ?
                   ORDER BY
                     CASE
                       WHEN education_levels LIKE '%elementary%' THEN 0
                       WHEN education_levels LIKE '%middle%' THEN 1
                       WHEN education_levels LIKE '%high%' THEN 2
                       ELSE 3
                     END,
                     distance_in_miles ASC""",
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
