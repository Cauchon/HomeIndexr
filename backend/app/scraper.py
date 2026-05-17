"""Realtor.com GraphQL scraper + AVM normalization.

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

import requests

SOLD_TO_OFF_MARKET_DAYS = 180

REALTOR_GQL_URL = "https://www.realtor.com/frontdoor/graphql"

DEFAULT_HEADERS = {
    "Content-Type": "application/json",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Cache-Control": "no-cache",
    "Origin": "https://www.realtor.com",
    "Pragma": "no-cache",
    "Referer": "https://www.realtor.com/",
    "rdc-client-name": "RDC_WEB_SRP_FS_PAGE",
    "rdc-client-version": "3.0.2515",
    "sec-ch-ua": '"Google Chrome";v="135", "Not-A.Brand";v="8", "Chromium";v="135"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"macOS"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/135.0.0.0 Safari/537.36"
    ),
    "x-is-bot": "false",
}


def _post_gql(operation_name: str, query: str, variables: dict) -> dict:
    """POST a GraphQL operation to Realtor and return the parsed JSON body."""
    payload = {
        "operationName": operation_name,
        "query": query,
        "variables": variables,
    }
    resp = requests.post(
        REALTOR_GQL_URL,
        headers=DEFAULT_HEADERS,
        data=json.dumps(payload, separators=(",", ":")),
        timeout=20,
    )
    resp.raise_for_status()
    return resp.json()


SEARCH_SUGGESTIONS_QUERY = (
    "query Search_suggestions($searchInput: SearchSuggestionsInput!) {"
    "  search_suggestions(search_input: $searchInput) {"
    "    geo_results { geo { _id mpr_id area_type } }"
    "  }"
    "}"
)

HOME_DETAILS_QUERY = (
    "query GetHomeDetails($property_id: ID!) {"
    "  home(property_id: $property_id) {"
    "    property_id listing_id href permalink"
    "    status mls_status pending_date"
    "    list_price last_sold_price last_sold_date last_status_change_date"
    "    list_date days_on_market"
    "    last_price_change_amount last_price_change_date"
    "    hoa { fee }"
    "    description {"
    "      beds baths_full baths_half sqft lot_sqft year_built"
    "      type sub_type stories garage garage_type"
    "      pool cooling heating fireplace"
    "    }"
    "    flags { is_new_listing is_price_reduced is_pending is_contingent is_foreclosure }"
    "    local { flood { flood_factor_score flood_factor_severity } }"
    "    schools {"
    "      schools {"
    "        id name rating grades distance_in_miles"
    "        education_levels funding_type student_count"
    "      }"
    "    }"
    "    location {"
    "      address {"
    "        line city state_code postal_code"
    "        coordinate { lat lon }"
    "      }"
    "    }"
    "    estimates {"
    "      currentValues: current_values {"
    "        source { type name }"
    "        estimate"
    "        estimateHigh: estimate_high"
    "        estimateLow: estimate_low"
    "        date"
    "        isBestHomeValue: isbest_homevalue"
    "      }"
    "    }"
    "  }"
    "}"
)


def _search_suggestions(address: str) -> str | None:
    """Geocode a free-text address to a Realtor mpr_id. Returns None if no address match."""
    data = _post_gql(
        "Search_suggestions",
        SEARCH_SUGGESTIONS_QUERY,
        {"searchInput": {"search_term": address}},
    )
    results = (
        ((data.get("data") or {}).get("search_suggestions") or {}).get("geo_results")
        or []
    )
    for r in results:
        geo = (r or {}).get("geo") or {}
        if geo.get("area_type") != "address":
            continue
        mpr = geo.get("mpr_id")
        if mpr:
            return str(mpr)
        gid = geo.get("_id") or ""
        if isinstance(gid, str) and gid.startswith("addr:"):
            return gid[len("addr:") :]
    return None


def _get_home_details(property_id: str) -> dict | None:
    """Fetch a property by id. Returns the home node dict, or None if missing."""
    data = _post_gql(
        "GetHomeDetails",
        HOME_DETAILS_QUERY,
        {"property_id": str(property_id)},
    )
    home = (data.get("data") or {}).get("home")
    return home if isinstance(home, dict) else None

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
    data = _post_gql(
        "GetHomeHistoricalEstimates",
        HISTORICAL_QUERY,
        {"property_id": str(property_id)},
    )
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


def _norm_address_query(s: str | None) -> str:
    out = _norm_str(s)
    out = re.sub(r"\b(united states|usa|u\.s\.a\.|us)\b\.?$", "", out)
    return out.strip(" ,")


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
    """Project a Realtor.com home node into normalized property fields."""
    loc = (raw.get("location") or {}).get("address") or {}
    coord = loc.get("coordinate") or {}
    desc = raw.get("description") or {}
    est = _normalize_estimates(raw)
    hoa = raw.get("hoa") or {}
    flags = raw.get("flags") or {}
    flood = ((raw.get("local") or {}).get("flood")) or {}
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
        "list_date": raw.get("list_date"),
        "days_on_market": _to_int(raw.get("days_on_market")),
        "last_price_change_amount": _to_int(raw.get("last_price_change_amount")),
        "last_price_change_date": raw.get("last_price_change_date"),
        "hoa_fee": _to_int(hoa.get("fee")),
        "property_type": desc.get("type"),
        "property_sub_type": desc.get("sub_type"),
        "stories": _to_int(desc.get("stories")),
        "garage": _to_int(desc.get("garage")),
        "garage_type": desc.get("garage_type"),
        "pool": desc.get("pool"),
        "cooling": desc.get("cooling"),
        "heating": desc.get("heating"),
        "fireplace": desc.get("fireplace"),
        "is_new_listing": _to_bool(flags.get("is_new_listing")),
        "is_price_reduced": _to_bool(flags.get("is_price_reduced")),
        "is_foreclosure": _to_bool(flags.get("is_foreclosure")),
        "flood_factor_score": _to_int(flood.get("flood_factor_score")),
        "flood_factor_severity": flood.get("flood_factor_severity"),
        "schools": _normalize_schools(raw),
    }


def _to_bool(v: Any) -> int | None:
    if v is None:
        return None
    return 1 if bool(v) else 0


def _normalize_schools(raw: dict) -> list[dict]:
    """Flatten Realtor schools list into stable per-school records."""
    schools = ((raw.get("schools") or {}).get("schools")) or []
    out: list[dict] = []
    seen: set[str] = set()
    for s in schools:
        if not isinstance(s, dict):
            continue
        sid = str(s.get("id") or "").strip()
        name = s.get("name")
        if not sid or not name or sid in seen:
            continue
        seen.add(sid)
        grades = s.get("grades") or []
        levels = s.get("education_levels") or []
        out.append({
            "school_id": sid,
            "name": name,
            "rating": _to_int(s.get("rating")),
            "grades": ",".join(str(g) for g in grades) if grades else None,
            "education_levels": ",".join(str(l) for l in levels) if levels else None,
            "funding_type": s.get("funding_type"),
            "distance_in_miles": float(s["distance_in_miles"]) if s.get("distance_in_miles") is not None else None,
            "student_count": _to_int(s.get("student_count")),
        })
    return out


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


def _match_status(raw: dict, query: str) -> str:
    """Decide whether the resolved property matches the user's query.

    Returns "matched" if the resolved address agrees with the input. This keeps
    the mismatch gate for nearby candidates, while allowing common copied
    address formats such as multiline addresses with a trailing country.
    """
    nq = _norm_address_query(query)
    if _norm_address_query(_build_matched_address(raw) or "") == nq:
        return "matched"
    loc_addr = ((raw.get("location") or {}).get("address") or {})
    addr_line = loc_addr.get("line") or ""
    if _norm_str(addr_line) == nq.split(",")[0].strip():
        return "matched"
    city = _title_city(loc_addr.get("city"))
    state = loc_addr.get("state_code")
    zip_ = loc_addr.get("postal_code")
    if (
        addr_line
        and city
        and state
        and zip_
        and _norm_str(addr_line) in nq
        and _norm_str(city) in nq
        and re.search(rf"\b{re.escape(_norm_str(state))}\b", nq)
        and re.search(rf"\b{re.escape(str(zip_))}\b", nq)
    ):
        return "matched"
    return "candidate_mismatch"


def fetch(address: str) -> dict:
    """Fetch a property from Realtor.com via direct GraphQL. Returns a dict with:
        status: matched | candidate_mismatch | no_candidates | error
        matched_address, normalized fields, raw_json, error
    """
    address = (address or "").strip()
    if not address:
        return {"status": "error", "error": "empty address", "raw_json": None}

    try:
        mpr_id = _search_suggestions(address)
        if not mpr_id:
            return {"status": "no_candidates", "error": None, "raw_json": None}
        raw = _get_home_details(mpr_id)
    except Exception as e:  # noqa: BLE001
        return {"status": "error", "error": f"{type(e).__name__}: {e}", "raw_json": None}

    if not raw:
        return {"status": "no_candidates", "error": None, "raw_json": None}

    flat = _flatten(raw)
    flat["status"] = _match_status(raw, address)
    flat["raw_json"] = raw
    flat["error"] = None
    return flat
