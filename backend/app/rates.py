"""Live mortgage-rate anchor from FRED (Freddie Mac Primary Mortgage Market Survey).

The frontend mortgage calculator applies its own credit-band / term spreads on
top of a national-average anchor. This module supplies that anchor from the
St. Louis Fed's FRED API when a `FRED_API_KEY` is configured (environment or
ignored `.env`, per AGENTS.md rule #13), and caches it daily in `app_settings`.

PMMS publishes weekly (Thursdays), so a daily cache is plenty. When no key is
configured — or a fetch fails with no usable cache — the endpoint reports
`available: false` and the frontend falls back to its static anchor.
"""

from __future__ import annotations

import time
from typing import Any

import requests

from . import store

# FRED series → payload field. MORTGAGE30US / MORTGAGE15US are the Freddie Mac
# 30- and 15-year fixed averages.
SERIES = {"rate_30": "MORTGAGE30US", "rate_15": "MORTGAGE15US"}
SOURCE = "Freddie Mac PMMS via FRED"
CACHE_TTL_MS = 24 * 60 * 60 * 1000  # one day


def _now_ms() -> int:
    return int(time.time() * 1000)


def _fetch_latest(series_id: str, api_key: str, base: str) -> dict | None:
    """Most recent non-missing observation as {value, date}, or None."""
    resp = requests.get(
        f"{base}/series/observations",
        params={
            "series_id": series_id,
            "api_key": api_key,
            "file_type": "json",
            "sort_order": "desc",
            "limit": 5,
        },
        timeout=15,
    )
    resp.raise_for_status()
    for obs in resp.json().get("observations", []):
        raw = obs.get("value")
        if raw in (None, "", "."):  # FRED encodes missing values as "."
            continue
        try:
            return {"value": round(float(raw), 2), "date": obs.get("date")}
        except (TypeError, ValueError):
            continue
    return None


def fetch_mortgage_rates() -> dict:
    """Hit FRED for the latest 30- and 15-yr fixed averages. Raises on network error."""
    api_key = store.get_fred_api_key()
    base = store.get_fred_api_base()
    out: dict[str, Any] = {"source": SOURCE, "fetched_at": _now_ms()}
    obs_date: str | None = None
    for field, series_id in SERIES.items():
        latest = _fetch_latest(series_id, api_key, base)
        out[field] = latest["value"] if latest else None
        if latest and latest.get("date"):
            obs_date = max(obs_date, latest["date"]) if obs_date else latest["date"]
    out["observation_date"] = obs_date
    return out


def _unavailable(meta: dict, **extra: Any) -> dict:
    return {
        **meta,
        "available": False,
        "rate_30": None,
        "rate_15": None,
        "observation_date": None,
        "fetched_at": None,
        **extra,
    }


def get_mortgage_rates(*, force: bool = False) -> dict:
    """Cached live rates. Serves last-good cache (or `available: false`) on error."""
    key_present = store.get_fred_api_key() is not None
    meta = {"source": SOURCE, "key_present": key_present, "key_env_var": "FRED_API_KEY"}
    if not key_present:
        return _unavailable(meta)

    cached = store.get_cached_mortgage_rates()
    fresh = (
        cached
        and not force
        and cached.get("fetched_at")
        and _now_ms() - cached["fetched_at"] < CACHE_TTL_MS
    )
    if fresh:
        return {**meta, "available": cached.get("rate_30") is not None, **cached}

    try:
        fetched = fetch_mortgage_rates()
    except Exception:  # noqa: BLE001 — network/parse failure: serve stale cache if any
        if cached:
            return {**meta, "available": cached.get("rate_30") is not None, "stale": True, **cached}
        return _unavailable(meta, error="fetch failed")

    store.save_mortgage_rates_cache(fetched)
    return {**meta, "available": fetched.get("rate_30") is not None, **fetched}
