// Comparable-listing ranking for the property detail page — ported from
// backend/app/comps.py.
//
// Pure functions only — no I/O, no Realtor calls. Gate candidate for-sale
// listings to strict appraisal-style comparables and rank survivors by a
// weighted similarity score (AGENTS.md rule #15). Keep the scoring here — one
// pure module; don't fork it.

import { pyround, pyround2 } from './pyround'

// Dissimilarity weights. The score normalizes by the weights actually used, so a
// candidate missing a dimension isn't unfairly penalized.
const WEIGHTS: Record<string, number> = {
  sqft: 0.35,
  distance: 0.15,
  year_built: 0.15,
  beds: 0.15,
  baths: 0.1,
  lot_sqft: 0.1,
}

// Difference that maps to a fully-dissimilar (1.0) contribution per dimension.
const SQFT_FULL_DIFF = 1.0 // relative: 100% larger/smaller
const LOT_FULL_DIFF = 1.0 // relative
const YEAR_FULL_DIFF = 50.0 // 50 years apart
const BEDS_FULL_DIFF = 3.0
const BATHS_FULL_DIFF = 3.0
const DISTANCE_FULL_DIFF = 5.0 // miles

// Strict appraisal-style gates.
const SQFT_GATE = 0.25 // ±25% living area
const SQFT_GATE_RELAXED = 0.4 // fallback widen
const BEDS_GATE = 1 // ±1 bedroom

const _NEAREST_LABEL = 'showing the nearest matches'

function _f(v: any): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function _clamp01(x: number): number {
  return x < 0 ? 0.0 : x > 1 ? 1.0 : x
}

function radians(deg: number): number {
  return (deg * Math.PI) / 180
}

// Great-circle distance in miles, or null if any coordinate is missing.
export function haversine_miles(lat1: any, lon1: any, lat2: any, lon2: any): number | null {
  const coords = [_f(lat1), _f(lon1), _f(lat2), _f(lon2)]
  if (coords.some((c) => c === null)) return null
  const [la1, lo1, la2, lo2] = coords as number[]
  const r = 3958.7613 // earth radius, miles
  const p1 = radians(la1)
  const p2 = radians(la2)
  const dphi = radians(la2 - la1)
  const dlmb = radians(lo2 - lo1)
  const h =
    Math.sin(dphi / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dlmb / 2) ** 2
  return 2 * r * Math.asin(Math.min(1.0, Math.sqrt(h)))
}

export function price_per_sqft(price: any, sqft: any): number | null {
  const p = _f(price)
  const s = _f(sqft)
  if (p === null || !s) return null
  return Math.trunc(pyround(p / s))
}

// Return [match %, distance_mi]. Only dimensions present on both sides count.
function _match_pct(subject: any, c: any): [number, number | null] {
  const dims: [number, number][] = [] // (weight, normalized 0..1 difference)

  const add = (weight: number, sval: any, cval: any, full: number, relative = false): void => {
    const sv = _f(sval)
    const cv = _f(cval)
    if (sv === null || cv === null) return
    let diff: number
    if (relative) {
      if (!sv) return
      diff = Math.abs(cv - sv) / sv
    } else {
      diff = Math.abs(cv - sv)
    }
    dims.push([weight, _clamp01(diff / full)])
  }

  add(WEIGHTS.sqft, subject.sqft, c.sqft, SQFT_FULL_DIFF, true)
  add(WEIGHTS.year_built, subject.year_built, c.year_built, YEAR_FULL_DIFF)
  add(WEIGHTS.beds, subject.beds, c.beds, BEDS_FULL_DIFF)
  add(WEIGHTS.baths, subject.baths, c.baths, BATHS_FULL_DIFF)
  add(WEIGHTS.lot_sqft, subject.lot_sqft, c.lot_sqft, LOT_FULL_DIFF, true)

  const dist = haversine_miles(subject.latitude, subject.longitude, c.latitude, c.longitude)
  if (dist !== null) {
    dims.push([WEIGHTS.distance, _clamp01(dist / DISTANCE_FULL_DIFF)])
  }

  if (!dims.length) return [0, dist]
  const total_w = dims.reduce((acc, [w]) => acc + w, 0)
  const dissimilarity = dims.reduce((acc, [w, d]) => acc + w * d, 0) / total_w
  return [pyround(100 * (1 - dissimilarity)), dist]
}

// User-selected filter pills (min/max price + sqft, min beds + baths). Applied
// BEFORE the appraisal gate ladder. A candidate missing a dimension is never
// excluded on that dimension.
function _passes_user_filter(c: any, f: any): boolean {
  const lp = _f(c.list_price)
  if (lp !== null) {
    if (f.min_price !== null && f.min_price !== undefined && lp < f.min_price) return false
    if (f.max_price !== null && f.max_price !== undefined && lp > f.max_price) return false
  }
  const cs = _f(c.sqft)
  if (cs !== null) {
    if (f.min_sqft !== null && f.min_sqft !== undefined && cs < f.min_sqft) return false
    if (f.max_sqft !== null && f.max_sqft !== undefined && cs > f.max_sqft) return false
  }
  const cb = _f(c.beds)
  if (cb !== null && f.min_beds !== null && f.min_beds !== undefined && cb < f.min_beds) return false
  const cba = _f(c.baths)
  if (cba !== null && f.min_baths !== null && f.min_baths !== undefined && cba < f.min_baths) return false
  return true
}

function _passes_gates(subject: any, c: any, sqft_tol: number | null, beds_gate: boolean): boolean {
  const st = subject.property_type
  const ct = c.property_type
  if (st && ct && st !== ct) return false
  const s_sqft = _f(subject.sqft)
  const c_sqft = _f(c.sqft)
  if (c_sqft === null) return false // candidate must have living area to be a comp
  if (sqft_tol !== null && s_sqft) {
    if (Math.abs(c_sqft - s_sqft) / s_sqft > sqft_tol) return false
  }
  if (beds_gate) {
    const s_beds = _f(subject.beds)
    const c_beds = _f(c.beds)
    if (s_beds !== null && c_beds !== null && Math.abs(c_beds - s_beds) > BEDS_GATE) return false
  }
  return true
}

// Gate + rank candidate listings into strict appraisal-style comparables.
// Returns {comps, relaxed, limited, subject_price_per_sqft}.
export function rank_comparables(
  subject: any | null,
  listings: any[] | null,
  filters: any | null = null,
  limit: number | null = 6,
): any {
  let list = (listings || []).filter((l) => l !== null && typeof l === 'object' && !Array.isArray(l))
  if (filters) {
    list = list.filter((c) => _passes_user_filter(c, filters))
  }
  subject = subject || {}

  // [label, sqft tolerance, enforce beds gate]. label null == strict, no note.
  const ladder: [string | null, number | null, boolean][] = [
    [null, SQFT_GATE, true],
    ['widened the size range to ±40%', SQFT_GATE_RELAXED, true],
    ['dropped the bedroom limit', SQFT_GATE_RELAXED, false],
    [_NEAREST_LABEL, null, false],
  ]

  let chosen: any[] = []
  let relaxed: string | null = null
  for (const [label, sqft_tol, beds_gate] of ladder) {
    const is_last = label === _NEAREST_LABEL
    const passed = is_last ? list : list.filter((c) => _passes_gates(subject, c, sqft_tol, beds_gate))
    if (passed.length || is_last) {
      chosen = passed
      relaxed = label
      break
    }
  }

  const scored: any[] = []
  for (const c of chosen) {
    const [match_pct, dist] = _match_pct(subject, c)
    const out = { ...c }
    out.comp_score = match_pct
    out.distance_mi = dist !== null ? pyround2(dist) : null
    out.price_per_sqft = price_per_sqft(c.list_price, c.sqft)
    scored.push(out)
  }

  scored.sort((a, b) => {
    if (a.comp_score !== b.comp_score) return b.comp_score - a.comp_score
    const da = a.distance_mi !== null && a.distance_mi !== undefined ? a.distance_mi : 9e9
    const db = b.distance_mi !== null && b.distance_mi !== undefined ? b.distance_mi : 9e9
    if (da !== db) return da - db
    return (a.list_price || 0) - (b.list_price || 0)
  })

  let subject_price = subject.list_price
  if (subject_price === null || subject_price === undefined) {
    subject_price = subject.best_current_estimate
  }

  return {
    comps: limit === null ? scored : scored.slice(0, limit),
    relaxed,
    limited: _f(subject.sqft) === null,
    subject_price_per_sqft: price_per_sqft(subject_price, subject.sqft),
  }
}

// Stable filter-slider domain for the comp module: the price/sqft spread of the
// UNFILTERED comp set (the full ranked pool, not just the shown page).
export function comp_domain(subject: any | null, listings: any[] | null): any {
  const base = rank_comparables(subject, listings, null, null).comps
  const prices = base
    .map((c: any) => _f(c.list_price))
    .filter((v: number | null) => v !== null)
    .map((v: number) => Math.trunc(pyround(v)))
  const sqfts = base
    .map((c: any) => _f(c.sqft))
    .filter((v: number | null) => v !== null)
    .map((v: number) => Math.trunc(pyround(v)))
  return { prices, sqfts, count: base.length }
}
