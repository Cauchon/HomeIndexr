// Live mortgage-rate anchor from FRED (Freddie Mac PMMS) — ported from
// backend/app/rates.py. Supplies the national-average anchor the frontend
// calculator builds its credit-band/term spreads on top of; cached daily in
// app_settings (AGENTS.md rule #17). available:false → frontend static anchor.

import * as store from './store'
import { pyround2 } from './pyround'

// FRED series → payload field. MORTGAGE30US / MORTGAGE15US are the Freddie Mac
// 30- and 15-year fixed averages.
const SERIES: Record<string, string> = { rate_30: 'MORTGAGE30US', rate_15: 'MORTGAGE15US' }
export const SOURCE = 'Freddie Mac PMMS via FRED'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // one day

function _now_ms(): number {
  return Date.now()
}

// Most recent non-missing observation as {value, date}, or null.
async function _fetch_latest(series_id: string, api_key: string, base: string): Promise<any | null> {
  const params = new URLSearchParams({
    series_id,
    api_key,
    file_type: 'json',
    sort_order: 'desc',
    limit: '5',
  })
  const resp = await fetch(`${base}/series/observations?${params.toString()}`, {
    signal: AbortSignal.timeout(15000),
  })
  if (!resp.ok) throw new Error(`FRED HTTP ${resp.status}`)
  const data = await resp.json()
  for (const obs of data.observations || []) {
    const raw = obs.value
    if (raw === null || raw === undefined || raw === '' || raw === '.') continue // FRED missing = "."
    const num = Number(raw)
    if (!Number.isFinite(num)) continue
    return { value: pyround2(num), date: obs.date }
  }
  return null
}

// Hit FRED for the latest 30- and 15-yr fixed averages. Throws on network error.
export async function fetch_mortgage_rates(): Promise<any> {
  const api_key = store.get_fred_api_key() as string
  const base = store.get_fred_api_base()
  const out: any = { source: SOURCE, fetched_at: _now_ms() }
  let obs_date: string | null = null
  for (const [field, series_id] of Object.entries(SERIES)) {
    const latest = await _fetch_latest(series_id, api_key, base)
    out[field] = latest ? latest.value : null
    if (latest && latest.date) {
      obs_date = obs_date ? (latest.date > obs_date ? latest.date : obs_date) : latest.date
    }
  }
  out.observation_date = obs_date
  return out
}

function _unavailable(meta: any, extra: any = {}): any {
  return {
    ...meta,
    available: false,
    rate_30: null,
    rate_15: null,
    observation_date: null,
    fetched_at: null,
    ...extra,
  }
}

// Cached live rates. Serves last-good cache (or available:false) on error.
export async function get_mortgage_rates(force = false): Promise<any> {
  const key_present = store.get_fred_api_key() !== null
  const meta = { source: SOURCE, key_present, key_env_var: 'FRED_API_KEY' }
  if (!key_present) return _unavailable(meta)

  const cached = store.get_cached_mortgage_rates()
  const fresh = cached && !force && cached.fetched_at && _now_ms() - cached.fetched_at < CACHE_TTL_MS
  if (fresh) {
    return { ...meta, available: cached.rate_30 !== null && cached.rate_30 !== undefined, ...cached }
  }

  let fetched: any
  try {
    fetched = await fetch_mortgage_rates()
  } catch {
    // network/parse failure: serve stale cache if any
    if (cached) {
      return { ...meta, available: cached.rate_30 !== null && cached.rate_30 !== undefined, stale: true, ...cached }
    }
    return _unavailable(meta, { error: 'fetch failed' })
  }

  store.save_mortgage_rates_cache(fetched)
  return { ...meta, available: fetched.rate_30 !== null && fetched.rate_30 !== undefined, ...fetched }
}
