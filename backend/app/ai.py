from __future__ import annotations

import json
from typing import Any

import requests

from . import store


class AIError(RuntimeError):
    pass


# Cap on how many times the model may call tools before we force a final answer.
# Each step is one extra DeepSeek round-trip, so keep it small.
MAX_TOOL_STEPS = 4
WEB_SEARCH_TIMEOUT = 20
GEOCODE_TIMEOUT = 20
CHAT_TIMEOUT = 45


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
    raw_location = (raw.get("location") or {}) if isinstance(raw.get("location"), dict) else {}
    context = {
        "property": {
            "id": prop.get("id"),
            "name": prop.get("property_name"),
            "address": prop.get("canonical_address") or prop.get("input_address"),
            "city": prop.get("city"),
            "state": prop.get("state"),
            "zip": prop.get("zip"),
            "latitude": prop.get("latitude"),
            "longitude": prop.get("longitude"),
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
        # Pass the Realtor location subtree and listing description in full rather
        # than a thin hint — these carry coordinates and free-text that the model
        # can mine, and feed the geocoding tools when a question (e.g. neighborhood)
        # isn't answerable from structured fields.
        "raw_realtor": {
            "status": raw.get("status"),
            "list_price": raw.get("list_price"),
            "description": raw.get("description") or raw.get("text"),
            "location": raw_location.get("address") or raw_location,
            "top_level_keys": sorted(list(raw.keys()))[:80],
        },
    }
    return _clean_obj(context)


# ---------- tools ----------


def _tool_specs(*, has_web_search: bool) -> list[dict]:
    specs: list[dict] = []
    if has_web_search:
        specs.append(
            {
                "type": "function",
                "function": {
                    "name": "web_search",
                    "description": (
                        "Search the public web for facts not present in the supplied "
                        "property data — neighborhood name, school boundaries, local "
                        "market trends, nearby amenities, recent news. Returns titles, "
                        "URLs, and snippets. Always cite the URLs you use."
                    ),
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "query": {"type": "string", "description": "Search query."},
                            "count": {
                                "type": "integer",
                                "description": "Number of results (1-10, default 5).",
                            },
                        },
                        "required": ["query"],
                    },
                },
            }
        )
    specs.append(
        {
            "type": "function",
            "function": {
                "name": "reverse_geocode",
                "description": (
                    "Resolve a latitude/longitude to a place: neighborhood, suburb, "
                    "city, county, state, postcode. Use this to answer 'what "
                    "neighborhood/area is this in'. Defaults to the property's own "
                    "coordinates when lat/lon are omitted."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "lat": {"type": "number", "description": "Latitude."},
                        "lon": {"type": "number", "description": "Longitude."},
                    },
                },
            },
        }
    )
    specs.append(
        {
            "type": "function",
            "function": {
                "name": "geocode_address",
                "description": (
                    "Resolve a free-text address to coordinates and structured "
                    "address parts (neighborhood, county, etc.). Use when you only "
                    "have an address string and need its location."
                ),
                "parameters": {
                    "type": "object",
                    "properties": {
                        "address": {"type": "string", "description": "Address to look up."},
                    },
                    "required": ["address"],
                },
            },
        }
    )
    return specs


def _web_search(query: str, count: int = 5) -> dict:
    key = store.get_brave_api_key()
    if not key:
        return {"error": "web search is not configured"}
    count = max(1, min(int(count or 5), 10))
    try:
        res = requests.get(
            f"{store.get_brave_api_base()}/web/search",
            headers={"Accept": "application/json", "X-Subscription-Token": key},
            params={"q": query, "count": count},
            timeout=WEB_SEARCH_TIMEOUT,
        )
    except requests.RequestException as e:
        return {"error": f"web search request failed: {e}"}
    if not res.ok:
        return {"error": f"web search HTTP {res.status_code}", "detail": res.text[:200]}
    data = res.json() if res.content else {}
    results = ((data.get("web") or {}).get("results")) or []
    trimmed = [
        {
            "title": r.get("title"),
            "url": r.get("url"),
            "description": r.get("description"),
        }
        for r in results[:count]
    ]
    return {"query": query, "results": trimmed}


def _geocoder_get(path: str, params: dict) -> dict:
    try:
        res = requests.get(
            f"{store.get_geocoder_base()}{path}",
            headers={"User-Agent": store.get_geocoder_user_agent()},
            params={**params, "format": "jsonv2", "addressdetails": 1},
            timeout=GEOCODE_TIMEOUT,
        )
    except requests.RequestException as e:
        return {"error": f"geocoder request failed: {e}"}
    if not res.ok:
        return {"error": f"geocoder HTTP {res.status_code}", "detail": res.text[:200]}
    return res.json() if res.content else {}


def _format_place(entry: dict) -> dict:
    addr = entry.get("address") or {}
    return {
        "display_name": entry.get("display_name"),
        "lat": entry.get("lat"),
        "lon": entry.get("lon"),
        "neighborhood": addr.get("neighbourhood") or addr.get("suburb") or addr.get("quarter"),
        "suburb": addr.get("suburb"),
        "city": addr.get("city") or addr.get("town") or addr.get("village"),
        "county": addr.get("county"),
        "state": addr.get("state"),
        "postcode": addr.get("postcode"),
    }


def _reverse_geocode(prop: dict, lat: Any = None, lon: Any = None) -> dict:
    lat = lat if lat is not None else prop.get("latitude")
    lon = lon if lon is not None else prop.get("longitude")
    if lat is None or lon is None:
        return {"error": "no coordinates available for this property"}
    data = _geocoder_get("/reverse", {"lat": lat, "lon": lon})
    if data.get("error"):
        return data
    return _format_place(data)


def _geocode_address(address: str) -> dict:
    if not address or not str(address).strip():
        return {"error": "address is required"}
    data = _geocoder_get("/search", {"q": str(address).strip(), "limit": 1})
    if isinstance(data, dict) and data.get("error"):
        return data
    if not isinstance(data, list) or not data:
        return {"error": "no geocoding match"}
    return _format_place(data[0])


def _dispatch_tool(prop: dict, name: str, args: dict) -> dict:
    try:
        if name == "web_search":
            return _web_search(args.get("query", ""), args.get("count", 5))
        if name == "reverse_geocode":
            return _reverse_geocode(prop, args.get("lat"), args.get("lon"))
        if name == "geocode_address":
            return _geocode_address(args.get("address", ""))
    except Exception as e:  # noqa: BLE001 — tool failures must not crash the loop
        return {"error": f"{type(e).__name__}: {e}"}
    return {"error": f"unknown tool: {name}"}


def _accumulate_usage(total: dict, usage: dict) -> None:
    for k in ("prompt_tokens", "completion_tokens", "total_tokens"):
        if usage.get(k) is not None:
            total[k] = total.get(k, 0) + int(usage[k])


def _chat_completion(base: str, api_key: str, payload: dict) -> dict:
    try:
        res = requests.post(
            f"{base}/chat/completions",
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=CHAT_TIMEOUT,
        )
    except requests.RequestException as e:
        raise AIError(f"DeepSeek request failed: {e}") from e
    if not res.ok:
        raise AIError(f"DeepSeek returned HTTP {res.status_code}: {res.text[:500]}")
    return res.json()


def answer_property_question(prop: dict, question: str) -> dict:
    api_key = store.get_deepseek_api_key()
    if not api_key:
        raise AIError("DeepSeek API key is not configured")

    model = store.get_deepseek_model()
    base = store.get_deepseek_api_base()
    context = build_property_context(prop)
    has_web_search = bool(store.get_brave_api_key())
    tools = _tool_specs(has_web_search=has_web_search)

    tool_lines = [
        "- reverse_geocode / geocode_address: resolve coordinates or an address to a "
        "neighborhood, county, and place name.",
    ]
    if has_web_search:
        tool_lines.insert(
            0,
            "- web_search: look up public facts that aren't in the data (neighborhood, "
            "schools, local market, amenities, news).",
        )

    system = (
        "You are HomeIndexr's property research assistant. Answer using the supplied "
        "local property data first: current values, historical estimates, market events, "
        "observed refresh events, taxes, schools, and the Realtor raw data. Be direct. "
        "Do not claim causality when the data only supports correlation.\n\n"
        "When the supplied data cannot answer the question, USE YOUR TOOLS to look it up "
        "rather than telling the user to check elsewhere:\n"
        + "\n".join(tool_lines)
        + "\n\nCite specific tool results (including URLs from web_search) in a short "
        "'Evidence used' section listing the rows, fields, or sources you relied on."
    )
    messages: list[dict] = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": (
                "Question:\n"
                f"{question.strip()}\n\n"
                "Property data JSON:\n"
                f"{json.dumps(context, ensure_ascii=False, sort_keys=True)}"
            ),
        },
    ]

    usage_total: dict = {}
    tools_used: list[str] = []

    for step in range(MAX_TOOL_STEPS + 1):
        payload: dict = {
            "model": model,
            "messages": messages,
            "temperature": 0.2,
            "max_tokens": 900,
            "stream": False,
        }
        # On the final allowed step, drop tools so the model must answer.
        if tools and step < MAX_TOOL_STEPS:
            payload["tools"] = tools
            payload["tool_choice"] = "auto"

        data = _chat_completion(base, api_key, payload)
        _accumulate_usage(usage_total, data.get("usage") or {})
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError) as e:
            raise AIError("DeepSeek returned an unexpected response") from e

        tool_calls = message.get("tool_calls") or []
        if not tool_calls:
            return {
                "answer": message.get("content") or "",
                "model": data.get("model") or model,
                "usage": usage_total,
                "tools_used": tools_used,
                "context": {
                    "historical_estimates": len(context.get("historical_estimates_recent", [])),
                    "events": len(context.get("market_and_observed_events_recent", [])),
                    "tax_rows": len(context.get("tax_history_recent", [])),
                    "schools": len(context.get("schools", [])),
                    "web_search_enabled": has_web_search,
                },
            }

        # Echo the assistant tool-call message back, then append each tool result.
        messages.append(message)
        for call in tool_calls:
            fn = (call.get("function") or {})
            name = fn.get("name") or ""
            try:
                args = json.loads(fn.get("arguments") or "{}")
            except (TypeError, ValueError):
                args = {}
            result = _dispatch_tool(prop, name, args)
            if name and name not in tools_used:
                tools_used.append(name)
            messages.append(
                {
                    "role": "tool",
                    "tool_call_id": call.get("id"),
                    "content": json.dumps(result, ensure_ascii=False),
                }
            )

    raise AIError("AI did not produce an answer within the tool-call limit")
