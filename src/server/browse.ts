// Browse-pool aggregation for the Browse tab — ported from backend/app/browse.py.
//
// Pure functions only — no I/O, no Realtor calls. Unions the per-ZIP
// area_listings cache into one pool, dedupes it, drops tracked homes, attaches
// price_per_sqft, and derives filter facets (bounds + histogram). The route
// feeds in cached rows + tracked property_ids; this module just shapes the pool.

import { price_per_sqft } from './comps'
import { pyround } from './pyround'

// Buckets in the price histogram drawn behind the dual-range price slider.
const PRICE_BUCKETS = 24

// Upper bound for price/sqft sliders is capped at this percentile of the pool so
// a handful of mansions can't stretch the track and bury the bulk of homes.
const _CAP_PCTILE = 0.97

// Year built skews the other way — a lone old farmhouse stretches the low end —
// so the year slider floors its lower bound at this percentile instead.
const _FLOOR_PCTILE = 0.03

// Fallbacks when the pool is empty (or a dimension is missing) so the sliders
// still have a sane span.
const _PRICE_FALLBACK: [number, number] = [200_000, 1_500_000]
const _SQFT_FALLBACK: [number, number] = [800, 3_500]
const _YEAR_FALLBACK: [number, number] = [1_900, 2_026]

// Union the per-ZIP caches into one deduped pool of untracked homes.
// area_rows is what store.get_all_area_listings() returns (newest cache first);
// exclude_ids are tracked Realtor property_ids to drop. Returns {homes, zips, fetched_at}.
export function build_pool(area_rows: any[] | null, exclude_ids: Set<string> | null = null): any {
  const exclude = exclude_ids || new Set<string>()
  const homes: any[] = []
  const seen = new Set<string>()
  const zips: string[] = []
  let fetched_at: number | null = null
  for (const row of area_rows || []) {
    const z = row.zip
    if (z && !zips.includes(z)) zips.push(z)
    const fa = row.fetched_at
    if (fa !== null && fa !== undefined && (fetched_at === null || fa > fetched_at)) {
      fetched_at = fa
    }
    for (const listing of row.listings || []) {
      const pid = String(listing.property_id ?? '')
      if (!pid || seen.has(pid) || exclude.has(pid)) continue
      seen.add(pid)
      const home = { ...listing }
      home.price_per_sqft = price_per_sqft(listing.list_price, listing.sqft)
      homes.push(home)
    }
  }
  // Newest listings first (smallest days-on-market), then priciest — a stable
  // default; the client re-sorts to the user's chosen order.
  homes.sort((a, b) => {
    const da = _as_int(a.days_on_market)
    const db = _as_int(b.days_on_market)
    if (da !== db) return da - db
    return -_as_int(a.list_price, 0) - -_as_int(b.list_price, 0)
  })
  return { homes, zips, fetched_at }
}

// Derive filter facets for a pool: value bounds, price histogram, cities present,
// and a count per listing status. Bounds adapt to the real pool (rounded outward).
export function pool_facets(homes: any[] | null): any {
  homes = homes || []
  const prices = homes.map((h) => _opt_int(h.list_price)).filter((p): p is number => !!p).sort((a, b) => a - b)
  const sqfts = homes.map((h) => _opt_int(h.sqft)).filter((s): s is number => !!s).sort((a, b) => a - b)
  const years = homes.map((h) => _opt_int(h.year_built)).filter((y): y is number => !!y).sort((a, b) => a - b)

  const price_bounds = _round_bounds(prices, 25_000, _PRICE_FALLBACK, _CAP_PCTILE, null)
  const bounds = {
    price: [price_bounds[0], price_bounds[1]],
    sqft: (() => {
      const b = _round_bounds(sqfts, 100, _SQFT_FALLBACK, _CAP_PCTILE, null)
      return [b[0], b[1]]
    })(),
    year: (() => {
      const b = _round_bounds(years, 1, _YEAR_FALLBACK, null, _FLOOR_PCTILE)
      return [b[0], b[1]]
    })(),
  }

  const statuses: Record<string, number> = {}
  const cities: string[] = []
  for (const h of homes) {
    const state = h.listing_state || 'off_market'
    statuses[state] = (statuses[state] || 0) + 1
    const city = h.city
    if (city && !cities.includes(city)) cities.push(city)
  }

  return {
    count: homes.length,
    bounds,
    price_hist: _histogram(prices, price_bounds[0], price_bounds[1], PRICE_BUCKETS),
    cities,
    statuses,
  }
}

// ---------- numeric helpers ----------
function _opt_int(value: any): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.trunc(n)
}

function _as_int(value: any, def = 10 ** 9): number {
  const n = _opt_int(value)
  return n === null ? def : n
}

// Nearest-rank percentile (q in 0..1) over numeric vals.
function _percentile(vals: number[], q: number): number {
  const s = [...vals].sort((a, b) => a - b)
  if (!s.length) return 0
  const k = Math.max(0, Math.min(s.length - 1, pyround(q * (s.length - 1))))
  return s[k]
}

// Min/max rounded outward to a step. cap_pct replaces the upper bound with that
// percentile (clip high tail); floor_pct replaces the lower bound (clip low tail).
function _round_bounds(
  vals: number[],
  step: number,
  fallback: [number, number],
  cap_pct: number | null,
  floor_pct: number | null,
): [number, number] {
  if (!vals.length) return fallback
  const bottom = floor_pct !== null ? _percentile(vals, floor_pct) : Math.min(...vals)
  const top = cap_pct !== null ? _percentile(vals, cap_pct) : Math.max(...vals)
  const lo = Math.floor(bottom / step) * step
  let hi = Math.ceil(top / step) * step
  if (hi <= lo) hi = lo + step
  return [Math.trunc(lo), Math.trunc(hi)]
}

function _histogram(vals: number[], lo: number, hi: number, buckets: number): number[] {
  const out = new Array(buckets).fill(0)
  const span = hi - lo
  if (!vals.length || span <= 0) return out
  for (const v of vals) {
    let idx = Math.trunc(((v - lo) / span) * buckets)
    if (idx >= buckets) idx = buckets - 1
    else if (idx < 0) idx = 0
    out[idx] += 1
  }
  return out
}
