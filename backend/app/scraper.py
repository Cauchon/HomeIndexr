"""HomeHarvest wrapper + AVM normalization.

Normalizes AVM data from both shapes:
  - raw["current_estimates"]              (snake_case, flat list)
  - raw["estimates"]["currentValues"]     (camelCase, nested)

Result keys:
  best_current_estimate, estimate_source,
  estimate_low, estimate_high, estimate_date
"""
from __future__ import annotations

import re
from typing import Any

import homeharvest

LISTING_TYPES = ["for_sale", "sold", "pending", "for_rent"]


def _norm_str(s: str | None) -> str:
    return re.sub(r"\s+", " ", (s or "")).strip().lower()


def _to_int(v: Any) -> int | None:
    try:
        if v is None:
            return None
        return int(round(float(v)))
    except (TypeError, ValueError):
        return None


def _build_matched_address(raw: dict) -> str | None:
    loc = (raw.get("location") or {}).get("address") or {}
    line = loc.get("line")
    city = loc.get("city")
    state = loc.get("state_code")
    zip_ = loc.get("postal_code")
    if line and city and state and zip_:
        return f"{line}, {city}, {state} {zip_}"
    return line or None


def _normalize_estimates(raw: dict) -> dict:
    """Pick the 'best' AVM from either shape.

    Preference order:
      1. Entry flagged isBestHomeValue
      2. First entry in the list
    """
    best: dict[str, Any] | None = None
    src_shape: str | None = None

    legacy = raw.get("current_estimates")
    if isinstance(legacy, list) and legacy:
        picked = next((e for e in legacy if e.get("isBestHomeValue")), legacy[0])
        best = {
            "estimate": picked.get("estimate"),
            "low": picked.get("estimate_low"),
            "high": picked.get("estimate_high"),
            "date": picked.get("date"),
            "source": _source_name(picked.get("source")),
        }
        src_shape = "current_estimates"
    else:
        nested = (raw.get("estimates") or {}).get("currentValues")
        if isinstance(nested, list) and nested:
            picked = next((e for e in nested if e.get("isBestHomeValue")), nested[0])
            best = {
                "estimate": picked.get("estimate"),
                "low": picked.get("estimateLow"),
                "high": picked.get("estimateHigh"),
                "date": picked.get("date"),
                "source": _source_name(picked.get("source")),
            }
            src_shape = "estimates.currentValues"

    if best is None:
        return {
            "best_current_estimate": None,
            "estimate_source": None,
            "estimate_low": None,
            "estimate_high": None,
            "estimate_date": None,
            "_shape": None,
        }
    return {
        "best_current_estimate": _to_int(best["estimate"]),
        "estimate_source": best["source"],
        "estimate_low": _to_int(best["low"]),
        "estimate_high": _to_int(best["high"]),
        "estimate_date": best["date"],
        "_shape": src_shape,
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
    """Project HomeHarvest raw row into normalized snapshot fields."""
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
        "listing_state": raw.get("status"),
        "city": loc.get("city"),
        "state": loc.get("state_code"),
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
