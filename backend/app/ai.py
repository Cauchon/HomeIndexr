from __future__ import annotations

import json
from typing import Any

import requests

from . import store


class AIError(RuntimeError):
    pass


def _clean_obj(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _clean_obj(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_clean_obj(v) for v in value]
    return value


def _take_sorted(rows: list[dict], key: str, limit: int) -> list[dict]:
    return sorted(rows or [], key=lambda r: str(r.get(key) or ""), reverse=True)[:limit]


def build_property_context(prop: dict) -> dict:
    raw = prop.get("raw_json") if isinstance(prop.get("raw_json"), dict) else {}
    context = {
        "property": {
            "id": prop.get("id"),
            "name": prop.get("property_name"),
            "address": prop.get("canonical_address") or prop.get("input_address"),
            "city": prop.get("city"),
            "state": prop.get("state"),
            "zip": prop.get("zip"),
            "listing_state": prop.get("listing_state"),
            "property_url": prop.get("property_url"),
            "last_fetched_at_ms": prop.get("last_fetched_at"),
        },
        "current_values": {
            "best_current_estimate": prop.get("best_current_estimate"),
            "estimate_source": prop.get("estimate_source"),
            "estimate_low": prop.get("estimate_low"),
            "estimate_high": prop.get("estimate_high"),
            "estimate_date": prop.get("estimate_date"),
            "list_price": prop.get("list_price"),
            "sold_price": prop.get("sold_price"),
            "last_sold_price": prop.get("last_sold_price"),
            "list_date": prop.get("list_date"),
            "days_on_market": prop.get("days_on_market"),
            "last_price_change_amount": prop.get("last_price_change_amount"),
            "last_price_change_date": prop.get("last_price_change_date"),
        },
        "facts": {
            "beds": prop.get("beds"),
            "baths": prop.get("baths"),
            "sqft": prop.get("sqft"),
            "lot_sqft": prop.get("lot_sqft"),
            "year_built": prop.get("year_built"),
            "property_type": prop.get("property_type"),
            "property_sub_type": prop.get("property_sub_type"),
            "hoa_fee": prop.get("hoa_fee"),
            "flood_factor_score": prop.get("flood_factor_score"),
            "flood_factor_severity": prop.get("flood_factor_severity"),
        },
        "current_estimates": prop.get("all_estimates") or [],
        "historical_estimates_recent": _take_sorted(prop.get("historical") or [], "date", 36),
        "market_and_observed_events_recent": _take_sorted(prop.get("events") or [], "date", 36),
        "tax_history_recent": _take_sorted(prop.get("tax_history") or [], "year", 8),
        "schools": prop.get("schools") or [],
        "raw_realtor_hint": {
            "top_level_keys": sorted(list(raw.keys()))[:80],
            "status": raw.get("status"),
            "list_price": raw.get("list_price"),
            "description": raw.get("description") or raw.get("text"),
        },
    }
    return _clean_obj(context)


def answer_property_question(prop: dict, question: str) -> dict:
    api_key = store.get_deepseek_api_key()
    if not api_key:
        raise AIError("DeepSeek API key is not configured")

    model = store.get_deepseek_model()
    base = store.get_deepseek_api_base()
    context = build_property_context(prop)

    system = (
        "You are HomeIndexr's property research assistant. Answer using the supplied "
        "local property data first: current values, historical estimates, market events, "
        "observed refresh events, taxes, schools, and Realtor raw-data hints. Be direct. "
        "Do not claim causality when the data only supports correlation. If the supplied "
        "data is insufficient, say what is missing and what to check next. Include a short "
        "'Evidence used' section with the specific rows or fields you relied on."
    )
    user = (
        "Question:\n"
        f"{question.strip()}\n\n"
        "Property data JSON:\n"
        f"{json.dumps(context, ensure_ascii=False, sort_keys=True)}"
    )
    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "temperature": 0.2,
        "max_tokens": 900,
        "stream": False,
    }

    try:
        res = requests.post(
            f"{base}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=45,
        )
    except requests.RequestException as e:
        raise AIError(f"DeepSeek request failed: {e}") from e

    if not res.ok:
        detail = res.text[:500]
        raise AIError(f"DeepSeek returned HTTP {res.status_code}: {detail}")

    data = res.json()
    try:
        answer = data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as e:
        raise AIError("DeepSeek returned an unexpected response") from e

    return {
        "answer": answer,
        "model": data.get("model") or model,
        "usage": data.get("usage") or {},
        "context": {
            "historical_estimates": len(context.get("historical_estimates_recent", [])),
            "events": len(context.get("market_and_observed_events_recent", [])),
            "tax_rows": len(context.get("tax_history_recent", [])),
            "schools": len(context.get("schools", [])),
        },
    }
