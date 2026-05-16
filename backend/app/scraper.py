"""HomeHarvest wrapper + AVM normalization.

Normalizes AVM data from both shapes:
  - raw["current_estimates"]              (snake_case, flat list)
  - raw["estimates"]["currentValues"]     (camelCase, nested)

Result keys:
  best_current_estimate, estimate_source,
  estimate_low, estimate_high, estimate_date
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

import homeharvest
import requests
from homeharvest.core.scrapers import DEFAULT_HEADERS

LISTING_TYPES = ["for_sale", "sold", "pending", "for_rent"]
SOLD_TO_OFF_MARKET_DAYS = 180

REALTOR_GQL_URL = "https://www.realtor.com/frontdoor/graphql"

HISTORICAL_QUERY = (
    "query GetHomeHistoricalEstimates($property_id: ID!) {"
    "  home(property_id: $property_id) {"
    "    property_history {"
    "      date event_name price"
    "    }"
    "    taxHistory: tax_history {"
    "      tax year assessed_year tax_code_area"
    "      assessment { building land total }"
    "      market { building land total }"
    "      appraisal { building land total }"
    "      value { building land total }"
    "    }"
    "    estimates {"
    "      historical_values {"
    "        source { type name }"
    "        estimates { estimate date }"
    "      }"
    "    }"
    "  }"
    "}"
)


def fetch_history_bundle(property_id: str) -> dict:
    """Fetch historical AVMs and market events for a property from Realtor.com.

    Returns:
      estimates: flat {source, date, estimate} records across available vendors.
      events: flat {date, event_name, price} records from Realtor property_history.
      taxes: flat tax assessment records from Realtor tax_history.

    Collateral Analytics is filtered out of estimates to match `all_estimates`.
    """
    if not property_id:
        return {"estimates": [], "events": [], "taxes": []}
    payload = {
        "operationName": "GetHomeHistoricalEstimates",
        "query": HISTORICAL_QUERY,
        "variables": {"property_id": str(property_id)},
    }
    resp = requests.post(
        REALTOR_GQL_URL,
        headers=DEFAULT_HEADERS,
        data=json.dumps(payload, separators=(",", ":")),
        timeout=20,
    )
    resp.raise_for_status()
    data = resp.json()
    home = (data.get("data") or {}).get("home") or {}
    series = (
        (home.get("estimates") or {})
        .get("historical_values")
        or []
    )
    estimates: list[dict] = []
    for s in series:
        src = _source_name((s or {}).get("source")) or "Unknown"
        if src.lower() == "collateral analytics":
            continue
        for e in s.get("estimates") or []:
            est = _to_int(e.get("estimate"))
            date = e.get("date")
            if est is None or not date:
                continue
            estimates.append({"source": src, "date": date[:10], "estimate": est})

    events: list[dict] = []
    seen_events: set[tuple[str, str, int]] = set()
    for e in home.get("property_history") or []:
        date = e.get("date")
        name = e.get("event_name")
        price = _to_int(e.get("price"))
        if not date or not name or price is None:
            continue
        key = (date[:10], str(name), price)
        if key in seen_events:
            continue
        seen_events.add(key)
        events.append({"date": key[0], "event_name": key[1], "price": key[2]})

    taxes = _normalize_tax_history(home.get("taxHistory") or home.get("tax_history") or [])
    return {"estimates": estimates, "events": events, "taxes": taxes}


def fetch_historical(property_id: str) -> list[dict]:
    """Fetch full historical AVM series for a property from Realtor.com."""
    return fetch_history_bundle(property_id)["estimates"]


def _assessment_parts(row: dict, key: str) -> dict:
    data = row.get(key)
    if not isinstance(data, dict):
        data = {}
    return {
        f"{key}_building": _to_int(data.get("building")),
        f"{key}_land": _to_int(data.get("land")),
        f"{key}_total": _to_int(data.get("total")),
    }


def _normalize_tax_history(rows: list[dict]) -> list[dict]:
    """Return Realtor tax_history records in a stable flat shape."""
    out: list[dict] = []
    seen: set[int] = set()
    for row in rows or []:
        if not isinstance(row, dict):
            continue
        year = _to_int(row.get("year"))
        if year is None or year in seen:
            continue
        seen.add(year)
        item = {
            "year": year,
            "assessed_year": _to_int(row.get("assessed_year")),
            "tax": _to_int(row.get("tax")),
            "tax_code_area": row.get("tax_code_area"),
        }
        for key in ("assessment", "market", "appraisal", "value"):
            item.update(_assessment_parts(row, key))
        out.append(item)
    return sorted(out, key=lambda x: x["year"])


def _norm_str(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _to_int(v: Any) -> int | None:
    try:
        if v is None:
            return None
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def _norm_status(s: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "_", str(s or "").strip().lower()).strip("_")


def _parse_date_ms(value: Any) -> int | None:
    if not value:
        return None
    if isinstance(value, (int, float)):
        # Realtor fields are normally ISO dates, but accept epoch seconds/ms.
        return int(value if value > 10_000_000_000 else value * 1000)
    if not isinstance(value, str):
        return None
    text = value.strip()
    if not text:
        return None
    try:
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        return int(datetime.fromisoformat(text).timestamp() * 1000)
    except ValueError:
        try:
            parsed = datetime.strptime(text[:10], "%Y-%m-%d")
            return int(parsed.replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            return None


def _sale_date_ms(raw: dict) -> int | None:
    for key in (
        "last_sold_date",
        "sold_date",
        "close_date",
        "closing_date",
        "last_status_change_date",
    ):
        parsed = _parse_date_ms(raw.get(key))
        if parsed is not None:
            return parsed
    return None


def normalize_listing_state(raw: dict | None, now_ms: int | None = None) -> str:
    """Return one dashboard listing bucket.

    Precedence:
      1. Explicit sold / closed current-status cues, but only for
         SOLD_TO_OFF_MARKET_DAYS after sale date.
      2. Pending / contingent / under-contract cues.
      3. Active for-sale cues.
      4. Other sold cues, but only for SOLD_TO_OFF_MARKET_DAYS after sale date.
      5. Off market.
    """
    if not isinstance(raw, dict):
        return "off_market"

    now_ms = now_ms or int(datetime.now(tz=timezone.utc).timestamp() * 1000)
    status = _norm_status(raw.get("status"))
    mls = _norm_status(raw.get("mls_status"))
    statuses = {status, mls}
    statuses.discard("")

    sold_words = ("sold", "closed")
    has_sold_status = any(any(word in s for word in sold_words) for s in statuses)
    if has_sold_status:
        sale_ms = _sale_date_ms(raw)
        if sale_ms is not None:
            age_days = (now_ms - sale_ms) / 86_400_000
            if 0 <= age_days <= SOLD_TO_OFF_MARKET_DAYS:
                return "sold"
        return "off_market"

    pending_words = ("pending", "under_contract", "contingent")
    if raw.get("pending_date") or any(any(word in s for word in pending_words) for s in statuses):
        return "pending"

    active_statuses = {"for_sale", "active", "coming_soon", "new_listing"}
    has_active_cue = bool(statuses & active_statuses)
    if has_active_cue:
        return "for_sale"
    if raw.get("list_price") is not None and raw.get("listing_id") and not has_sold_status:
        return "for_sale"

    has_sold_cue = (
        raw.get("sold_price") is not None
        or raw.get("last_sold_date") is not None
    )
    if has_sold_cue:
        sale_ms = _sale_date_ms(raw)
        if sale_ms is not None:
            age_days = (now_ms - sale_ms) / 86_400_000
            if 0 <= age_days <= SOLD_TO_OFF_MARKET_DAYS:
                return "sold"
        return "off_market"

    return "off_market"


def _title_city(city: str | None) -> str | None:
    if not city:
        return None
    city = " ".join(city.split())
    if city == city.lower() or city == city.upper():
        return " ".join(part[:1].upper() + part[1:].lower() for part in city.split())
    return city


def _build_matched_address(raw: dict) -> str | None:
    loc = (raw.get("location") or {}).get("address") or {}
    line = loc.get("line")
    city = _title_city(loc.get("city"))
    state = loc.get("state_code").upper() if loc.get("state_code") else None
    zip_ = loc.get("postal_code")
    if line and city and state and zip_:
        return f"{line}, {city}, {state} {zip_}"
    return line or None


def all_estimates(raw: dict) -> list[dict]:
    """Return every AVM in the raw row, normalized to one shape.

    Reads both `current_estimates` (snake_case) and
    `estimates.currentValues` (camelCase). The entry flagged
    `isBestHomeValue` is moved to the front; other entries keep their
    original order.
    """
    if not isinstance(raw, dict):
        return []
    items: list[dict] = []
    legacy = raw.get("current_estimates")
    if isinstance(legacy, list) and legacy:
        for e in legacy:
            items.append({
                "source": _source_name(e.get("source")),
                "estimate": _to_int(e.get("estimate")),
                "low": _to_int(e.get("estimate_low")),
                "high": _to_int(e.get("estimate_high")),
                "date": e.get("date"),
                "is_best": bool(e.get("isBestHomeValue")),
            })
    else:
        nested = (raw.get("estimates") or {}).get("currentValues")
        if isinstance(nested, list) and nested:
            for e in nested:
                items.append({
                    "source": _source_name(e.get("source")),
                    "estimate": _to_int(e.get("estimate")),
                    "low": _to_int(e.get("estimateLow")),
                    "high": _to_int(e.get("estimateHigh")),
                    "date": e.get("date"),
                    "is_best": bool(e.get("isBestHomeValue")),
                })
    items = [e for e in items if (e.get("source") or "").lower() != "collateral analytics"]
    items.sort(key=lambda x: 0 if x["is_best"] else 1)
    return items


def _normalize_estimates(raw: dict) -> dict:
    """Pick the 'best' AVM.

    Preference order:
      1. Entry flagged isBestHomeValue
      2. First entry in the list
    """
    items = all_estimates(raw)
    if not items:
        return {
            "best_current_estimate": None,
            "estimate_source": None,
            "estimate_low": None,
            "estimate_high": None,
            "estimate_date": None,
        }
    picked = items[0]
    return {
        "best_current_estimate": picked["estimate"],
        "estimate_source": picked["source"],
        "estimate_low": picked["low"],
        "estimate_high": picked["high"],
        "estimate_date": picked["date"],
    }


def _source_name(s: Any) -> str | None:
    if not s:
        return None
    if isinstance(s, str):
        return s
    if isinstance(s, dict):
        return s.get("name") or s.get("type")
    return None


def _baths_combined(desc: dict) -> float | None:
    if not desc:
        return None
    full = desc.get("baths_full")
    half = desc.get("baths_half")
    if full is None and half is None:
        b = desc.get("baths")
        return float(b) if b is not None else None
    return float(full or 0) + 0.5 * float(half or 0)


def _flatten(raw: dict) -> dict:
    """Project HomeHarvest raw row into normalized property fields."""
    loc = (raw.get("location") or {}).get("address") or {}
    coord = loc.get("coordinate") or {}
    desc = raw.get("description") or {}
    est = _normalize_estimates(raw)
    return {
        "matched_address": _build_matched_address(raw),
        "best_current_estimate": est["best_current_estimate"],
        "estimate_source": est["estimate_source"],
        "estimate_low": est["estimate_low"],
        "estimate_high": est["estimate_high"],
        "estimate_date": est["estimate_date"],
        "list_price": _to_int(raw.get("list_price")),
        "sold_price": _to_int(raw.get("sold_price")),
        "last_sold_price": _to_int(raw.get("last_sold_price")),
        "beds": desc.get("beds"),
        "baths": _baths_combined(desc),
        "sqft": desc.get("sqft"),
        "lot_sqft": desc.get("lot_sqft"),
        "year_built": desc.get("year_built"),
        "latitude": coord.get("lat"),
        "longitude": coord.get("lon"),
        "property_id": raw.get("property_id"),
        "listing_id": raw.get("listing_id"),
        "property_url": _href(raw),
        "listing_state": normalize_listing_state(raw),
        "city": _title_city(loc.get("city")),
        "state": loc.get("state_code").upper() if loc.get("state_code") else None,
        "zip": loc.get("postal_code"),
    }


def _href(raw: dict) -> str | None:
    h = raw.get("href")
    if h:
        return h
    p = raw.get("permalink")
    if p:
        if p.startswith("http"):
            return p
        return f"https://www.realtor.com/realestateandhomes-detail/{p}"
    return None


def _pick_best_candidate(rows: list[dict], query: str) -> tuple[dict | None, str]:
    """Choose the best candidate and decide match status.

    Returns (raw_row, status) where status is one of:
      matched, candidate_mismatch
    Caller handles no_candidates / error separately.
    """
    nq = _norm_str(query)
    # exact substring match on the line first
    for row in rows:
        addr = _build_matched_address(row) or ""
        if _norm_str(addr) == nq:
            return row, "matched"
    # try prefix match on street line
    nstart = nq.split(",")[0].strip()
    for row in rows:
        addr_line = ((row.get("location") or {}).get("address") or {}).get("line") or ""
        if _norm_str(addr_line) == nstart:
            return row, "matched"
    # fall through to first
    return rows[0], "candidate_mismatch"


def fetch(address: str) -> dict:
    """Fetch a property from HomeHarvest. Returns a dict with:
        status: matched | candidate_mismatch | no_candidates | error
        matched_address, normalized fields, raw_json, error
    """
    address = (address or "").strip()
    if not address:
        return {"status": "error", "error": "empty address", "raw_json": None}

    try:
        rows = homeharvest.scrape_property(
            address,
            return_type="raw",
            listing_type=LISTING_TYPES,
            limit=5,
            extra_property_data=False,
        )
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "error": f"{type(e).__name__}: {e}", "raw_json": None}

    if not rows:
        return {"status": "no_candidates", "error": None, "raw_json": None}

    raw, status = _pick_best_candidate(rows, address)
    flat = _flatten(raw)
    flat["status"] = status
    flat["raw_json"] = raw
    flat["error"] = None
    return flat
