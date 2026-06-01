"""Comparable-listing ranking for the property detail page.

Pure functions only — no I/O, no Realtor calls. Given a subject property and a
list of candidate for-sale listings (from the per-ZIP area cache), gate to
strict appraisal-style comparables and rank the survivors by a weighted
similarity score. The endpoint layer feeds in the cached listings; this module
just decides which are comparable and in what order.
"""
from __future__ import annotations

import math
from typing import Any

# Dissimilarity weights. The score normalizes by the weights actually used, so a
# candidate missing a dimension isn't unfairly penalized — that dimension just
# drops out of both numerator and denominator.
WEIGHTS = {
    "sqft": 0.35,
    "distance": 0.15,
    "year_built": 0.15,
    "beds": 0.15,
    "baths": 0.10,
    "lot_sqft": 0.10,
}

# Difference that maps to a fully-dissimilar (1.0) contribution per dimension.
SQFT_FULL_DIFF = 1.0      # relative: 100% larger/smaller
LOT_FULL_DIFF = 1.0       # relative
YEAR_FULL_DIFF = 50.0     # 50 years apart
BEDS_FULL_DIFF = 3.0
BATHS_FULL_DIFF = 3.0
DISTANCE_FULL_DIFF = 5.0  # miles (a ZIP is usually well under this)

# Strict appraisal-style gates.
SQFT_GATE = 0.25          # ±25% living area
SQFT_GATE_RELAXED = 0.40  # fallback widen
BEDS_GATE = 1             # ±1 bedroom

_NEAREST_LABEL = "showing the nearest matches"


def _f(v: Any) -> float | None:
    try:
        return None if v is None else float(v)
    except (TypeError, ValueError):
        return None


def _clamp01(x: float) -> float:
    return 0.0 if x < 0 else 1.0 if x > 1 else x


def haversine_miles(lat1: Any, lon1: Any, lat2: Any, lon2: Any) -> float | None:
    """Great-circle distance in miles, or None if any coordinate is missing."""
    coords = [_f(lat1), _f(lon1), _f(lat2), _f(lon2)]
    if any(c is None for c in coords):
        return None
    lat1, lon1, lat2, lon2 = coords
    r = 3958.7613  # earth radius, miles
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlmb = math.radians(lon2 - lon1)
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dlmb / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(h)))


def price_per_sqft(price: Any, sqft: Any) -> int | None:
    p, s = _f(price), _f(sqft)
    if p is None or not s:
        return None
    return int(round(p / s))


def _match_pct(subject: dict, c: dict) -> tuple[int, float | None]:
    """Return (match %, distance_mi). Only dimensions present on both sides count."""
    dims: list[tuple[float, float]] = []  # (weight, normalized 0..1 difference)

    def add(weight: float, sval: Any, cval: Any, full: float, relative: bool = False) -> None:
        sv, cv = _f(sval), _f(cval)
        if sv is None or cv is None:
            return
        if relative:
            if not sv:
                return
            diff = abs(cv - sv) / sv
        else:
            diff = abs(cv - sv)
        dims.append((weight, _clamp01(diff / full)))

    add(WEIGHTS["sqft"], subject.get("sqft"), c.get("sqft"), SQFT_FULL_DIFF, relative=True)
    add(WEIGHTS["year_built"], subject.get("year_built"), c.get("year_built"), YEAR_FULL_DIFF)
    add(WEIGHTS["beds"], subject.get("beds"), c.get("beds"), BEDS_FULL_DIFF)
    add(WEIGHTS["baths"], subject.get("baths"), c.get("baths"), BATHS_FULL_DIFF)
    add(WEIGHTS["lot_sqft"], subject.get("lot_sqft"), c.get("lot_sqft"), LOT_FULL_DIFF, relative=True)

    dist = haversine_miles(
        subject.get("latitude"), subject.get("longitude"),
        c.get("latitude"), c.get("longitude"),
    )
    if dist is not None:
        dims.append((WEIGHTS["distance"], _clamp01(dist / DISTANCE_FULL_DIFF)))

    if not dims:
        return 0, dist
    total_w = sum(w for w, _ in dims)
    dissimilarity = sum(w * d for w, d in dims) / total_w
    return round(100 * (1 - dissimilarity)), dist


def _passes_user_filter(c: dict, f: dict) -> bool:
    """User-selected filter pills (min/max price + sqft, min beds + baths).

    Applied *before* the appraisal gate ladder so ranking draws the best comps
    that match the filter from the whole cached pool. Mirrors the frontend rule:
    a candidate missing a dimension is never excluded on that dimension — only
    listings that actively fall outside a band the user set are dropped.
    """
    lp = _f(c.get("list_price"))
    if lp is not None:
        if f.get("min_price") is not None and lp < f["min_price"]:
            return False
        if f.get("max_price") is not None and lp > f["max_price"]:
            return False
    cs = _f(c.get("sqft"))
    if cs is not None:
        if f.get("min_sqft") is not None and cs < f["min_sqft"]:
            return False
        if f.get("max_sqft") is not None and cs > f["max_sqft"]:
            return False
    cb = _f(c.get("beds"))
    if cb is not None and f.get("min_beds") is not None and cb < f["min_beds"]:
        return False
    cba = _f(c.get("baths"))
    if cba is not None and f.get("min_baths") is not None and cba < f["min_baths"]:
        return False
    return True


def _passes_gates(subject: dict, c: dict, sqft_tol: float | None, beds_gate: bool) -> bool:
    st, ct = subject.get("property_type"), c.get("property_type")
    if st and ct and st != ct:
        return False
    s_sqft, c_sqft = _f(subject.get("sqft")), _f(c.get("sqft"))
    if c_sqft is None:  # candidate must have living area to be a comp
        return False
    if sqft_tol is not None and s_sqft:
        if abs(c_sqft - s_sqft) / s_sqft > sqft_tol:
            return False
    if beds_gate:
        s_beds, c_beds = _f(subject.get("beds")), _f(c.get("beds"))
        if s_beds is not None and c_beds is not None and abs(c_beds - s_beds) > BEDS_GATE:
            return False
    return True


def rank_comparables(subject: dict | None, listings: list[dict] | None,
                     filters: dict | None = None, limit: int | None = 6) -> dict:
    """Gate + rank candidate listings into strict appraisal-style comparables.

    Returns ``{comps, relaxed, limited, subject_price_per_sqft}``:
      - ``comps``: ranked list (best match first), each candidate dict copied
        with ``comp_score`` (match %), ``distance_mi``, and ``price_per_sqft``.
        Capped to ``limit`` (``None`` returns the whole ranked set).
      - ``relaxed``: ``None`` when the strict gates produced comps, else a short
        human label naming which fallback rung was used.
      - ``limited``: True when the subject itself lacks ``sqft`` (size gating and
        the $/sqft reference can't be computed).
      - ``subject_price_per_sqft``: the subject's own $/sqft reference line.

    ``filters`` (optional user-selected pills) pre-filters the candidate pool via
    ``_passes_user_filter`` *before* the gate ladder, so the strictest appraisal
    rung is computed over only the listings the user asked for — the returned
    comps are the best matches that are BOTH appraisal-comparable and in-filter.

    Fallback ladder: keep the strictest rung that yields ANY comp, so a thin ZIP
    shows a few precise comps rather than diluting with loose ones; only drop to
    the next rung when the current one is empty.
    """
    listings = [l for l in (listings or []) if isinstance(l, dict)]
    if filters:
        listings = [c for c in listings if _passes_user_filter(c, filters)]
    subject = subject or {}

    # (label, sqft tolerance, enforce beds gate). label None == strict, no note.
    ladder = [
        (None, SQFT_GATE, True),
        ("widened the size range to ±40%", SQFT_GATE_RELAXED, True),
        ("dropped the bedroom limit", SQFT_GATE_RELAXED, False),
        (_NEAREST_LABEL, None, False),
    ]

    chosen: list[dict] = []
    relaxed: str | None = None
    for label, sqft_tol, beds_gate in ladder:
        is_last = label == _NEAREST_LABEL
        passed = listings if is_last else [
            c for c in listings if _passes_gates(subject, c, sqft_tol, beds_gate)
        ]
        if passed or is_last:
            chosen = passed
            relaxed = label
            break

    scored: list[dict] = []
    for c in chosen:
        match_pct, dist = _match_pct(subject, c)
        out = dict(c)
        out["comp_score"] = match_pct
        out["distance_mi"] = round(dist, 2) if dist is not None else None
        out["price_per_sqft"] = price_per_sqft(c.get("list_price"), c.get("sqft"))
        scored.append(out)

    scored.sort(key=lambda x: (
        -x["comp_score"],
        x["distance_mi"] if x["distance_mi"] is not None else 9e9,
        x.get("list_price") or 0,
    ))

    subject_price = subject.get("list_price")
    if subject_price is None:
        subject_price = subject.get("best_current_estimate")

    return {
        "comps": scored if limit is None else scored[:limit],
        "relaxed": relaxed,
        "limited": _f(subject.get("sqft")) is None,
        "subject_price_per_sqft": price_per_sqft(subject_price, subject.get("sqft")),
    }


def comp_domain(subject: dict | None, listings: list[dict] | None) -> dict:
    """Stable filter-slider domain for the comp module: the price/sqft spread of
    the *unfiltered* comp set (the full ranked pool, not just the shown page).

    Returned to the frontend so the Price/Sqft sliders span the real comp
    universe and don't rescale every time the user applies a filter (which the
    server now honors by re-ranking). ``count`` lets the UI tell "this ZIP has no
    comps" apart from "your filters excluded them all".
    """
    base = rank_comparables(subject, listings, limit=None)["comps"]
    prices = [int(round(v)) for v in (_f(c.get("list_price")) for c in base) if v is not None]
    sqfts = [int(round(v)) for v in (_f(c.get("sqft")) for c in base) if v is not None]
    return {"prices": prices, "sqfts": sqfts, "count": len(base)}
