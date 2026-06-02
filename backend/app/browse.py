"""Browse-pool aggregation for the Browse tab.

Pure functions only — no I/O, no Realtor calls. The Browse tab is a cache-only
discovery surface: it unions the per-ZIP ``area_listings`` cache (populated by
property refresh, rule #14) into a single pool of for-sale homes the user can
filter and track. This module dedupes that union, drops homes already tracked,
attaches a ``price_per_sqft`` figure, and derives the facets the filter UI needs
(value bounds + a price histogram). The endpoint layer feeds in the cached rows
and the set of tracked Realtor ``property_id``s; this module just shapes the pool.

Filtering and sorting themselves happen client-side over the whole (bounded)
pool, so this module returns the full pool plus stable facets rather than a page
— the Browse analogue of how ``comps.comp_domain`` keeps the detail-page sliders
stable. Keep the shaping here in one place; don't fork it into the route.
"""
from __future__ import annotations

from .comps import price_per_sqft

# Buckets in the price histogram drawn behind the dual-range price slider.
PRICE_BUCKETS = 24

# Fallbacks when the pool is empty (or a dimension is entirely missing) so the
# Browse sliders still have a sane span to render against.
_PRICE_FALLBACK = (200_000, 1_500_000)
_SQFT_FALLBACK = (800, 3_500)
_YEAR_FALLBACK = (1_900, 2_026)


def build_pool(area_rows: list[dict] | None, exclude_ids: set[str] | None = None) -> dict:
    """Union the per-ZIP caches into one deduped pool of untracked homes.

    ``area_rows`` is what ``store.get_all_area_listings()`` returns (one dict per
    ZIP, newest cache first). ``exclude_ids`` are Realtor ``property_id``s already
    tracked — dropped so Browse only surfaces homes worth adding.

    Returns ``{homes, zips, fetched_at}``. Homes are the light listing card dicts
    with a derived ``price_per_sqft``, deduped by ``property_id`` (the newest ZIP
    cache wins, since rows arrive newest-first), ordered newest-listed first.
    """
    exclude = exclude_ids or set()
    homes: list[dict] = []
    seen: set[str] = set()
    zips: list[str] = []
    fetched_at: int | None = None
    for row in area_rows or []:
        z = row.get("zip")
        if z and z not in zips:
            zips.append(z)
        fa = row.get("fetched_at")
        if fa is not None and (fetched_at is None or fa > fetched_at):
            fetched_at = fa
        for listing in row.get("listings") or []:
            pid = str(listing.get("property_id") or "")
            if not pid or pid in seen or pid in exclude:
                continue
            seen.add(pid)
            home = dict(listing)
            home["price_per_sqft"] = price_per_sqft(
                listing.get("list_price"), listing.get("sqft")
            )
            homes.append(home)
    # Newest listings first (smallest days-on-market), then priciest, as a stable
    # default; the client re-sorts to the user's chosen order.
    homes.sort(key=lambda h: (_as_int(h.get("days_on_market")), -_as_int(h.get("list_price"), 0)))
    return {"homes": homes, "zips": zips, "fetched_at": fetched_at}


def pool_facets(homes: list[dict] | None) -> dict:
    """Derive filter facets for a pool: value bounds, a price histogram, the
    cities present, and a count per listing status.

    Bounds adapt to the real pool (rounded outward) so the dual-range sliders span
    the actual data rather than fixed mock constants.
    """
    homes = homes or []
    prices = sorted(p for p in (_opt_int(h.get("list_price")) for h in homes) if p)
    sqfts = sorted(s for s in (_opt_int(h.get("sqft")) for h in homes) if s)
    years = sorted(y for y in (_opt_int(h.get("year_built")) for h in homes) if y)

    price_bounds = _round_bounds(prices, 25_000, _PRICE_FALLBACK)
    bounds = {
        "price": list(price_bounds),
        "sqft": list(_round_bounds(sqfts, 100, _SQFT_FALLBACK)),
        "year": list(_minmax(years, _YEAR_FALLBACK)),
    }

    statuses: dict[str, int] = {}
    cities: list[str] = []
    for h in homes:
        state = h.get("listing_state") or "off_market"
        statuses[state] = statuses.get(state, 0) + 1
        city = h.get("city")
        if city and city not in cities:
            cities.append(city)

    return {
        "count": len(homes),
        "bounds": bounds,
        "price_hist": _histogram(prices, price_bounds[0], price_bounds[1], PRICE_BUCKETS),
        "cities": cities,
        "statuses": statuses,
    }


# ---------- numeric helpers ----------
def _opt_int(value) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _as_int(value, default: int = 10**9) -> int:
    n = _opt_int(value)
    return default if n is None else n


def _minmax(vals: list[int], fallback: tuple[int, int]) -> tuple[int, int]:
    if not vals:
        return fallback
    return (int(min(vals)), int(max(vals)))


def _round_bounds(vals: list[int], step: int, fallback: tuple[int, int]) -> tuple[int, int]:
    """Min/max rounded outward to a step, so slider ends land on round numbers."""
    if not vals:
        return fallback
    lo = (min(vals) // step) * step
    hi = -(-max(vals) // step) * step  # ceil to step
    if hi <= lo:
        hi = lo + step
    return (int(lo), int(hi))


def _histogram(vals: list[int], lo: int, hi: int, buckets: int) -> list[int]:
    out = [0] * buckets
    span = hi - lo
    if not vals or span <= 0:
        return out
    for v in vals:
        idx = int((v - lo) / span * buckets)
        if idx >= buckets:
            idx = buckets - 1
        elif idx < 0:
            idx = 0
        out[idx] += 1
    return out
