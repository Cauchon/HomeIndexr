// SQLite persistence helpers — ported from backend/app/store.py.
//
// Each property stores the latest fetched Realtor.com state directly on the
// property row. Adding the same address never creates a duplicate property.

import { randomBytes } from 'node:crypto'
import { with_conn } from './db'
import { dotenv_value } from './env'
import * as scraper from './scraper'

const PROPERTY_COLS = (
  'id property_name input_address canonical_address city state zip property_id listing_id property_url ' +
  'listing_state active status matched_address best_current_estimate estimate_source ' +
  'estimate_low estimate_high estimate_date list_price sold_price last_sold_price ' +
  'beds baths sqft lot_sqft year_built latitude longitude ' +
  'list_date days_on_market last_price_change_amount last_price_change_date hoa_fee ' +
  'property_type property_sub_type stories garage garage_type ' +
  'pool cooling heating fireplace ' +
  'is_new_listing is_price_reduced is_foreclosure ' +
  'flood_factor_score flood_factor_severity ' +
  'raw_json error last_fetched_at pinned created_at updated_at'
).split(' ')

const CURRENT_FIELDS = (
  'matched_address best_current_estimate estimate_source ' +
  'estimate_low estimate_high estimate_date list_price sold_price last_sold_price ' +
  'beds baths sqft lot_sqft year_built latitude longitude ' +
  'list_date days_on_market last_price_change_amount last_price_change_date hoa_fee ' +
  'property_type property_sub_type stories garage garage_type ' +
  'pool cooling heating fireplace ' +
  'is_new_listing is_price_reduced is_foreclosure ' +
  'flood_factor_score flood_factor_severity'
).split(' ')

function _now(): number {
  return Date.now()
}

// better-sqlite3 rejects undefined and JS booleans as bind values (Python's
// sqlite3 accepted both) — normalize at the bind boundary.
function bind(v: any): any {
  if (v === undefined) return null
  if (v === true) return 1
  if (v === false) return 0
  return v
}

function _norm(addr: string | null | undefined): string {
  return (addr || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

// The status to store on a tracked property row.
//
// A property only reaches the store once its match has been accepted: the add
// endpoint gates an unconfirmed *new* candidate_mismatch and never persists it.
// So a candidate_mismatch recomputed on an already-tracked property is a
// resolved decision, not a standing problem — store it as matched. Genuine
// problems (error, no_candidates) are kept so they still surface.
export function persisted_status(fetched: any): string {
  const status = fetched.status ?? 'matched'
  return status === 'candidate_mismatch' ? 'matched' : status
}

function _row_to_property(row: any): any {
  const p: any = {}
  for (const k of PROPERTY_COLS) p[k] = row[k] ?? null
  p.active = Boolean(p.active)
  p.pinned = Boolean(p.pinned)
  if (p.raw_json) {
    try {
      p.raw_json = JSON.parse(p.raw_json)
    } catch {
      /* keep the raw string, like Python */
    }
  }
  const raw_is_obj = p.raw_json !== null && typeof p.raw_json === 'object' && !Array.isArray(p.raw_json)
  p.all_estimates = raw_is_obj ? scraper.all_estimates(p.raw_json) : []
  if (raw_is_obj) {
    p.listing_state = scraper.normalize_listing_state(p.raw_json)
  }
  return p
}

function _raw_json_for_db(fetched: any): string | null {
  const raw = fetched.raw_json
  return raw !== null && raw !== undefined ? JSON.stringify(raw) : null
}

// ---------- secrets/config (environment or ignored .env, never SQLite) ----------

function _deepseek_key_source(): string | null {
  if (process.env.DEEPSEEK_API_KEY) return 'environment'
  if (dotenv_value('DEEPSEEK_API_KEY')) return 'dotenv'
  return null
}

export function get_deepseek_api_key(): string | null {
  return process.env.DEEPSEEK_API_KEY || dotenv_value('DEEPSEEK_API_KEY')
}

export function get_deepseek_model(): string {
  return process.env.DEEPSEEK_MODEL || dotenv_value('DEEPSEEK_MODEL') || 'deepseek-v4-flash'
}

export function get_deepseek_api_base(): string {
  return (
    process.env.DEEPSEEK_API_BASE ||
    dotenv_value('DEEPSEEK_API_BASE') ||
    'https://api.deepseek.com'
  ).replace(/\/+$/, '')
}

function _brave_key_source(): string | null {
  if (process.env.BRAVE_API_KEY) return 'environment'
  if (dotenv_value('BRAVE_API_KEY')) return 'dotenv'
  return null
}

// Brave Search API key, used to give the AI a web_search tool. Optional.
export function get_brave_api_key(): string | null {
  return process.env.BRAVE_API_KEY || dotenv_value('BRAVE_API_KEY')
}

export function get_brave_api_base(): string {
  return (
    process.env.BRAVE_API_BASE ||
    dotenv_value('BRAVE_API_BASE') ||
    'https://api.search.brave.com/res/v1'
  ).replace(/\/+$/, '')
}

// Nominatim-compatible geocoding endpoint. No key required.
export function get_geocoder_base(): string {
  return (
    process.env.GEOCODER_BASE ||
    dotenv_value('GEOCODER_BASE') ||
    'https://nominatim.openstreetmap.org'
  ).replace(/\/+$/, '')
}

export function get_geocoder_user_agent(): string {
  return (
    process.env.GEOCODER_USER_AGENT ||
    dotenv_value('GEOCODER_USER_AGENT') ||
    'HomeIndexr/1.0 (local property research)'
  )
}

function _fred_key_source(): string | null {
  if (process.env.FRED_API_KEY) return 'environment'
  if (dotenv_value('FRED_API_KEY')) return 'dotenv'
  return null
}

// FRED (St. Louis Fed) API key for live Freddie Mac mortgage averages. Optional.
export function get_fred_api_key(): string | null {
  return process.env.FRED_API_KEY || dotenv_value('FRED_API_KEY')
}

export function get_fred_api_base(): string {
  return (
    process.env.FRED_API_BASE ||
    dotenv_value('FRED_API_BASE') ||
    'https://api.stlouisfed.org/fred'
  ).replace(/\/+$/, '')
}

const _RATES_CACHE_KEY = 'mortgage_rates_cache'

// Last fetched FRED rate payload, or null. Non-secret, so it lives in app_settings.
export function get_cached_mortgage_rates(): any | null {
  const row: any = with_conn((conn) =>
    conn.prepare('SELECT value FROM app_settings WHERE key = ?').get(_RATES_CACHE_KEY),
  )
  if (!row || !row.value) return null
  try {
    return JSON.parse(row.value)
  } catch {
    return null
  }
}

export function save_mortgage_rates_cache(payload: any): void {
  const now = _now()
  with_conn((conn) =>
    conn
      .prepare(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(_RATES_CACHE_KEY, JSON.stringify(payload), now),
  )
}

function _date_from_ms(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null
  return new Date(ms).toISOString().slice(0, 10)
}

function _event_sort_ms(event: any): number {
  if (event.observed_at !== null && event.observed_at !== undefined) {
    return Math.trunc(event.observed_at)
  }
  const parsed = Date.parse(String(event.date).slice(0, 10) + 'T00:00:00Z')
  return Number.isFinite(parsed) ? parsed : 0
}

// Values for the CURRENT_FIELDS columns plus raw_json, error, last_fetched_at.
function _current_values(fetched: any, now: number): any[] {
  const base = CURRENT_FIELDS.map((k) => bind(fetched[k]))
  return [...base, _raw_json_for_db(fetched), bind(fetched.error), now]
}

const _CURRENT_COL_LIST = [...CURRENT_FIELDS, 'raw_json', 'error', 'last_fetched_at'].join(', ')
const _CURRENT_PLACEHOLDERS = Array(CURRENT_FIELDS.length + 3).fill('?').join(', ')
const _CURRENT_ASSIGNMENTS = [...CURRENT_FIELDS, 'raw_json', 'error', 'last_fetched_at']
  .map((c) => `${c} = ?`)
  .join(', ')
const _ACTIVE_LISTING_STATES = new Set(['for_sale', 'pending'])

export function find_property_by_address(input_address: string): any | null {
  const target = _norm(input_address)
  return with_conn((conn) => {
    for (const row of conn.prepare('SELECT * FROM properties').iterate() as any) {
      const cands = [row.canonical_address, row.input_address]
      if (cands.some((c) => c && _norm(c) === target)) {
        return _row_to_property(row)
      }
    }
    return null
  })
}

export function get_property(property_id: number): any | null {
  return with_conn((conn) => {
    const row = conn.prepare('SELECT * FROM properties WHERE id = ?').get(property_id)
    return row ? _row_to_property(row) : null
  })
}

// Return all properties with their current fetched Realtor.com state.
export function list_properties(): any[] {
  return with_conn((conn) =>
    conn
      .prepare('SELECT * FROM properties ORDER BY updated_at DESC')
      .all()
      .map(_row_to_property),
  )
}

export function get_ai_settings(): any {
  const rows: any[] = with_conn((conn) =>
    conn.prepare("SELECT key, value FROM app_settings WHERE key = 'ai_enabled'").all(),
  )
  const values: any = {}
  for (const row of rows) values[row.key] = row.value
  const key_source = _deepseek_key_source()
  const brave_source = _brave_key_source()
  return {
    enabled: values.ai_enabled === '1',
    provider: 'deepseek',
    has_deepseek_api_key: key_source !== null,
    deepseek_api_key_source: key_source,
    deepseek_api_key_env_var: 'DEEPSEEK_API_KEY',
    // Optional web_search tool. Geocoding tools need no key, so they are
    // always available whenever AI is enabled.
    has_brave_api_key: brave_source !== null,
    brave_api_key_source: brave_source,
    brave_api_key_env_var: 'BRAVE_API_KEY',
  }
}

export function save_ai_settings(changes: { enabled?: boolean | null } = {}): any {
  const now = _now()
  with_conn((conn) => {
    conn.prepare("DELETE FROM app_settings WHERE key = 'deepseek_api_key'").run()
    if (changes.enabled !== null && changes.enabled !== undefined) {
      conn
        .prepare(
          `INSERT INTO app_settings (key, value, updated_at)
           VALUES ('ai_enabled', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(changes.enabled ? '1' : '0', now)
    }
  })
  return get_ai_settings()
}

export function create_property(input_address: string, fetched: any): any {
  const now = _now()
  const canonical = fetched.matched_address || input_address
  const pid = with_conn((conn) => {
    const info = conn
      .prepare(
        `INSERT INTO properties
         (input_address, canonical_address, city, state, zip,
          property_id, listing_id, property_url, listing_state,
          active, status,
          ${_CURRENT_COL_LIST},
          created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,${_CURRENT_PLACEHOLDERS},?,?)`,
      )
      .run(
        input_address,
        canonical,
        bind(fetched.city),
        bind(fetched.state),
        bind(fetched.zip),
        bind(fetched.property_id),
        bind(fetched.listing_id),
        bind(fetched.property_url),
        bind(fetched.listing_state),
        1,
        persisted_status(fetched),
        ...(_current_values(fetched, now) as any[]),
        now,
        now,
      )
    return Number(info.lastInsertRowid)
  })
  replace_schools(pid, fetched.schools || [])
  return get_property(pid)
}

// Update user-managed property fields and return the updated row.
export function update_property(property_id: number, changes: any): any | null {
  const allowed = new Set([
    'property_name',
    'input_address',
    'canonical_address',
    'city',
    'state',
    'zip',
    'active',
    'pinned',
  ])
  const updates: any = {}
  for (const [k, v] of Object.entries(changes)) {
    if (allowed.has(k)) updates[k] = v
  }
  if (Object.keys(updates).length === 0) return get_property(property_id)

  const now = _now()
  const assignments: string[] = []
  const values: any[] = []
  const text_fields = new Set(['property_name', 'input_address', 'canonical_address', 'city', 'state', 'zip'])
  for (let [key, value] of Object.entries(updates) as [string, any][]) {
    if (text_fields.has(key)) {
      value = value !== null && value !== undefined ? String(value).trim().split(/\s+/).join(' ') : null
      if (value === '') value = null
      if (key === 'state' && value) value = value.toUpperCase()
      if (key === 'input_address' && !value) throw new Error('input_address is required')
    }
    if (key === 'active') value = value ? 1 : 0
    if (key === 'pinned') value = value ? 1 : 0
    assignments.push(`${key} = ?`)
    values.push(bind(value))
  }

  assignments.push('updated_at = ?')
  values.push(now, property_id)

  return with_conn((conn) => {
    const info = conn.prepare(`UPDATE properties SET ${assignments.join(', ')} WHERE id = ?`).run(...values)
    if (info.changes === 0) return null
    const row = conn.prepare('SELECT * FROM properties WHERE id = ?').get(property_id)
    return row ? _row_to_property(row) : null
  })
}

export function set_property_active(property_id: number, active: boolean): any | null {
  return update_property(property_id, { active })
}

export function delete_property(property_id: number): boolean {
  return with_conn((conn) => {
    const info = conn.prepare('DELETE FROM properties WHERE id = ?').run(property_id)
    return info.changes > 0
  })
}

function _observed_list_price_event(previous: any, fetched: any, now: number): any | null {
  let old_price = previous.list_price
  let new_price = fetched.list_price
  if (old_price === null || old_price === undefined || new_price === null || new_price === undefined) {
    return null
  }

  old_price = Math.trunc(old_price)
  new_price = Math.trunc(new_price)
  if (old_price === new_price) return null

  const old_state = previous.listing_state
  const new_state = fetched.listing_state
  if (!_ACTIVE_LISTING_STATES.has(old_state) || !_ACTIVE_LISTING_STATES.has(new_state)) {
    return null
  }

  const old_listing_id = previous.listing_id
  const new_listing_id = fetched.listing_id || old_listing_id
  if (old_listing_id && new_listing_id && old_listing_id !== new_listing_id) return null

  const delta = new_price - old_price
  return {
    property_id: previous.id,
    observed_at: now,
    date: _date_from_ms(now),
    event_name: delta < 0 ? 'Price dropped' : 'Price increased',
    source: 'observed',
    listing_state: new_state,
    listing_id: new_listing_id,
    old_price,
    new_price,
    price: new_price,
    delta,
    pct: old_price ? delta / old_price : null,
  }
}

function _insert_observed_event(conn: any, event: any): any | null {
  const info = conn
    .prepare(
      `INSERT OR IGNORE INTO observed_events
       (property_id, observed_at, event_name, source, listing_state, listing_id,
        old_price, new_price, price, delta, pct)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      event.property_id,
      event.observed_at,
      event.event_name,
      'refresh',
      bind(event.listing_state),
      bind(event.listing_id),
      bind(event.old_price),
      bind(event.new_price),
      event.price,
      bind(event.delta),
      bind(event.pct),
    )
  return info.changes ? event : null
}

// Refresh metadata/current fetched state and record observed price changes.
export function update_property_meta(property_id: number, fetched: any): any | null {
  const now = _now()
  let observed_event: any = null
  const status = persisted_status(fetched)
  with_conn((conn) => {
    const previous: any = conn
      .prepare('SELECT id, listing_state, listing_id, list_price FROM properties WHERE id = ?')
      .get(property_id)
    if (previous && status === 'matched') {
      observed_event = _observed_list_price_event(previous, fetched, now)
      if (observed_event) {
        observed_event = _insert_observed_event(conn, observed_event)
      }
    }

    conn
      .prepare(
        `UPDATE properties SET
           canonical_address = COALESCE(?, canonical_address),
           city               = COALESCE(?, city),
           state              = COALESCE(?, state),
           zip                = COALESCE(?, zip),
           property_id        = COALESCE(?, property_id),
           listing_id         = COALESCE(?, listing_id),
           property_url       = COALESCE(?, property_url),
           listing_state      = COALESCE(?, listing_state),
           status             = ?,
           ${_CURRENT_ASSIGNMENTS},
           updated_at         = ?
         WHERE id = ?`,
      )
      .run(
        bind(fetched.matched_address),
        bind(fetched.city),
        bind(fetched.state),
        bind(fetched.zip),
        bind(fetched.property_id),
        bind(fetched.listing_id),
        bind(fetched.property_url),
        bind(fetched.listing_state),
        status,
        ...(_current_values(fetched, now) as any[]),
        now,
        property_id,
      )
  })
  replace_schools(property_id, fetched.schools || [])
  return observed_event
}

// Cache the for-sale listings for a ZIP, overwriting any prior cache row.
export function upsert_area_listings(zip_code: string, listings: any[]): number {
  zip_code = (zip_code || '').trim()
  if (!zip_code) return 0
  const now = _now()
  with_conn((conn) =>
    conn
      .prepare(
        `INSERT INTO area_listings (zip, listings_json, fetched_at)
         VALUES (?,?,?)
         ON CONFLICT(zip) DO UPDATE SET
           listings_json = excluded.listings_json,
           fetched_at = excluded.fetched_at`,
      )
      .run(zip_code, JSON.stringify(listings), now),
  )
  return listings.length
}

// Read the cached for-sale listings for a ZIP. Never hits Realtor.
export function get_area_listings(zip_code: string): any {
  zip_code = (zip_code || '').trim()
  if (!zip_code) return { zip: null, fetched_at: null, listings: [] }
  const row: any = with_conn((conn) =>
    conn.prepare('SELECT zip, listings_json, fetched_at FROM area_listings WHERE zip = ?').get(zip_code),
  )
  if (!row) return { zip: zip_code, fetched_at: null, listings: [] }
  let listings: any[]
  try {
    listings = JSON.parse(row.listings_json)
  } catch {
    listings = []
  }
  return { zip: row.zip, fetched_at: row.fetched_at, listings }
}

// Read every cached per-ZIP listing row (newest first). Never hits Realtor.
export function get_all_area_listings(): any[] {
  const rows: any[] = with_conn((conn) =>
    conn
      .prepare('SELECT zip, listings_json, fetched_at, status FROM area_listings ORDER BY fetched_at DESC')
      .all(),
  )
  return rows.map((row) => {
    let listings: any[]
    try {
      listings = JSON.parse(row.listings_json)
    } catch {
      listings = []
    }
    return {
      zip: row.zip,
      fetched_at: row.fetched_at,
      status: row.status || 'active',
      listings,
    }
  })
}

// Fetch + cache for-sale listings for a ZIP. Best-effort: a Realtor block or
// upstream hiccup never breaks the core property refresh that triggered it.
export async function refresh_area_for_zip(zip_code: string): Promise<number> {
  zip_code = (zip_code || '').trim()
  if (!zip_code) return 0
  let listings: any[]
  try {
    listings = await scraper.fetch_area_listings(zip_code)
  } catch {
    return 0
  }
  return upsert_area_listings(zip_code, listings)
}

// Crawl + cache a ZIP from a user-initiated Tracked-areas action. Unlike
// refresh_area_for_zip this lets a Realtor error propagate so the Admin surface
// can report the failure honestly. Still one SRP request per ZIP (rule #14).
export async function crawl_area_zip(zip_code: string): Promise<number> {
  zip_code = (zip_code || '').trim()
  if (!zip_code) return 0
  const listings = await scraper.fetch_area_listings(zip_code)
  return upsert_area_listings(zip_code, listings)
}

// Pick the dominant city/state for a ZIP from its cached listings.
function _area_locality(listings: any[]): [string | null, string | null] {
  const city_counts: Record<string, number> = {}
  const state_counts: Record<string, number> = {}
  for (const l of listings) {
    const c = l.city
    const s = l.state
    if (c) city_counts[c] = (city_counts[c] || 0) + 1
    if (s) state_counts[s] = (state_counts[s] || 0) + 1
  }
  const argmax = (counts: Record<string, number>): string | null => {
    let best: string | null = null
    for (const k of Object.keys(counts)) {
      if (best === null || counts[k] > counts[best]) best = k
    }
    return best
  }
  return [argmax(city_counts), argmax(state_counts)]
}

// Per-ZIP Tracked-areas rows for the Admin panel. origin/locked are derived
// live from current property membership (rule #14). Newest crawl first.
export function list_area_coverage(): any[] {
  const property_zips = new Set(
    list_properties()
      .filter((p) => p.active && (p.zip || '').trim())
      .map((p) => (p.zip || '').trim()),
  )
  const rows: any[] = with_conn((conn) =>
    conn
      .prepare('SELECT zip, listings_json, fetched_at, status FROM area_listings ORDER BY fetched_at DESC')
      .all(),
  )
  return rows.map((row) => {
    let listings: any[]
    try {
      listings = JSON.parse(row.listings_json)
    } catch {
      listings = []
    }
    const [city, state] = _area_locality(listings)
    const locked = property_zips.has(row.zip)
    return {
      zip: row.zip,
      city,
      state,
      count: listings.length,
      status: row.status || 'active',
      fetched_at: row.fetched_at,
      origin: locked ? 'property' : 'manual',
      locked,
    }
  })
}

export function area_zip_exists(zip_code: string): boolean {
  zip_code = (zip_code || '').trim()
  if (!zip_code) return false
  const row = with_conn((conn) =>
    conn.prepare('SELECT 1 FROM area_listings WHERE zip = ?').get(zip_code),
  )
  return row !== undefined
}

// Pause/resume a tracked ZIP. Returns false if the ZIP isn't cached.
export function set_area_status(zip_code: string, status: string): boolean {
  zip_code = (zip_code || '').trim()
  if (status !== 'active' && status !== 'paused') {
    throw new Error(`invalid status: '${status}'`)
  }
  return with_conn((conn) => {
    const info = conn.prepare('UPDATE area_listings SET status = ? WHERE zip = ?').run(status, zip_code)
    return info.changes > 0
  })
}

// Drop a ZIP's cached index. Returns false if it wasn't tracked.
export function delete_area_listings(zip_code: string): boolean {
  zip_code = (zip_code || '').trim()
  return with_conn((conn) => {
    const info = conn.prepare('DELETE FROM area_listings WHERE zip = ?').run(zip_code)
    return info.changes > 0
  })
}

function _row_to_saved_search(row: any): any {
  let filters: any
  try {
    filters = JSON.parse(row.filters_json)
  } catch {
    filters = {}
  }
  return { id: row.id, name: row.name, filters, created_at: row.created_at }
}

// Every saved Browse search, newest first (matches the sidebar's order).
export function list_saved_searches(): any[] {
  const rows: any[] = with_conn((conn) =>
    conn
      .prepare('SELECT id, name, filters_json, created_at FROM saved_searches ORDER BY created_at DESC, id DESC')
      .all(),
  )
  return rows.map(_row_to_saved_search)
}

// Persist a named Browse filter set. The id is minted server-side.
export function create_saved_search(name: string, filters: any | null): any {
  const now = _now()
  const record = {
    id: `ss_${randomBytes(6).toString('hex')}`,
    name: (name || '').trim() || 'Saved search',
    filters: filters || {},
    created_at: now,
  }
  with_conn((conn) =>
    conn
      .prepare('INSERT INTO saved_searches (id, name, filters_json, created_at) VALUES (?,?,?,?)')
      .run(record.id, record.name, JSON.stringify(record.filters), now),
  )
  return record
}

// Remove a saved search. Returns false if the id wasn't found.
export function delete_saved_search(search_id: string): boolean {
  search_id = (search_id || '').trim()
  return with_conn((conn) => {
    const info = conn.prepare('DELETE FROM saved_searches WHERE id = ?').run(search_id)
    return info.changes > 0
  })
}

// Upsert historical estimates for a property. Returns rows written.
export function replace_historical(property_id: number, records: any[]): number {
  const now = _now()
  const rows = records
    .filter((r) => r.source && r.date && r.estimate !== null && r.estimate !== undefined)
    .map((r) => [property_id, r.source, r.date, Math.trunc(r.estimate), now])
  if (!rows.length) return 0
  with_conn((conn) => {
    const stmt = conn.prepare(
      'INSERT OR REPLACE INTO historical_estimates (property_id, source, date, estimate, fetched_at) VALUES (?,?,?,?,?)',
    )
    for (const row of rows) stmt.run(...row)
  })
  return rows.length
}

// Upsert Realtor market events for a property. Returns rows written.
export function replace_events(property_id: number, records: any[]): number {
  const now = _now()
  const rows: any[][] = []
  const seen = new Set<string>()
  for (const r of records) {
    const date = r.date
    const event_name = r.event_name
    const price = r.price
    if (!date || !event_name || price === null || price === undefined) continue
    const row = [property_id, String(date).slice(0, 10), String(event_name), Math.trunc(price), now]
    const key = JSON.stringify(row.slice(0, 4))
    if (seen.has(key)) continue
    seen.add(key)
    rows.push(row)
  }
  if (!rows.length) return 0
  with_conn((conn) => {
    const stmt = conn.prepare(
      'INSERT OR REPLACE INTO property_events (property_id, date, event_name, price, fetched_at) VALUES (?,?,?,?,?)',
    )
    for (const row of rows) stmt.run(...row)
  })
  return rows.length
}

// Upsert Realtor tax history for a property. Returns rows written.
export function replace_tax_history(property_id: number, records: any[]): number {
  const now = _now()
  const rows: any[][] = []
  const seen = new Set<number>()
  for (const r of records) {
    if (r.year === null || r.year === undefined) continue
    const year = Math.trunc(r.year)
    if (seen.has(year)) continue
    seen.add(year)
    rows.push([
      property_id,
      year,
      bind(r.assessed_year),
      bind(r.tax),
      bind(r.assessment_building),
      bind(r.assessment_land),
      bind(r.assessment_total),
      bind(r.market_building),
      bind(r.market_land),
      bind(r.market_total),
      bind(r.appraisal_building),
      bind(r.appraisal_land),
      bind(r.appraisal_total),
      bind(r.value_building),
      bind(r.value_land),
      bind(r.value_total),
      bind(r.tax_code_area),
      now,
    ])
  }
  if (!rows.length) return 0
  with_conn((conn) => {
    const stmt = conn.prepare(
      `INSERT OR REPLACE INTO tax_history
       (property_id, year, assessed_year, tax,
        assessment_building, assessment_land, assessment_total,
        market_building, market_land, market_total,
        appraisal_building, appraisal_land, appraisal_total,
        value_building, value_land, value_total,
        tax_code_area, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    for (const row of rows) stmt.run(...row)
  })
  return rows.length
}

export function list_historical(property_id: number): any[] {
  return with_conn((conn) =>
    (conn
      .prepare(
        'SELECT source, date, estimate FROM historical_estimates WHERE property_id = ? ORDER BY date ASC, source ASC',
      )
      .all(property_id) as any[]).map((r) => ({ source: r.source, date: r.date, estimate: r.estimate })),
  )
}

export function list_events(property_id: number): any[] {
  const [realtor_events, observed_events] = with_conn((conn) => {
    const realtor = (conn
      .prepare('SELECT date, event_name, price FROM property_events WHERE property_id = ?')
      .all(property_id) as any[]).map((r) => ({
      date: r.date,
      event_name: r.event_name,
      price: r.price,
      source: 'realtor',
    }))
    const observed = (conn
      .prepare(
        `SELECT observed_at, event_name, price, old_price, new_price, delta, pct
         FROM observed_events
         WHERE property_id = ?`,
      )
      .all(property_id) as any[]).map((r) => ({
      date: _date_from_ms(r.observed_at),
      event_name: r.event_name,
      price: r.price,
      source: 'observed',
      observed_at: r.observed_at,
      old_price: r.old_price,
      new_price: r.new_price,
      delta: r.delta,
      pct: r.pct,
    }))
    return [realtor, observed]
  })
  // Python sorts by the key tuple (ms, event_name or "", price or 0).
  return [...realtor_events, ...observed_events].sort((a, b) => {
    const ma = _event_sort_ms(a)
    const mb = _event_sort_ms(b)
    if (ma !== mb) return ma - mb
    const na = a.event_name || ''
    const nb = b.event_name || ''
    if (na !== nb) return na < nb ? -1 : 1
    return (a.price || 0) - (b.price || 0)
  })
}

// Replace the schools list for a property. Returns rows written.
export function replace_schools(property_id: number, records: any[]): number {
  const now = _now()
  const rows: any[][] = []
  const seen = new Set<string>()
  for (const r of records || []) {
    const sid = r.school_id
    const name = r.name
    if (!sid || !name || seen.has(sid)) continue
    seen.add(sid)
    rows.push([
      property_id,
      sid,
      name,
      bind(r.rating),
      bind(r.grades),
      bind(r.education_levels),
      bind(r.funding_type),
      bind(r.distance_in_miles),
      bind(r.student_count),
      now,
    ])
  }
  with_conn((conn) => {
    conn.prepare('DELETE FROM property_schools WHERE property_id = ?').run(property_id)
    if (rows.length) {
      const stmt = conn.prepare(
        `INSERT INTO property_schools
         (property_id, school_id, name, rating, grades, education_levels,
          funding_type, distance_in_miles, student_count, fetched_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      for (const row of rows) stmt.run(...row)
    }
  })
  return rows.length
}

export function list_schools(property_id: number): any[] {
  return with_conn((conn) =>
    (conn
      .prepare(
        `SELECT school_id, name, rating, grades, education_levels,
                funding_type, distance_in_miles, student_count
         FROM property_schools
         WHERE property_id = ?
         ORDER BY
           CASE
             WHEN education_levels LIKE '%elementary%' THEN 0
             WHEN education_levels LIKE '%middle%' THEN 1
             WHEN education_levels LIKE '%high%' THEN 2
             ELSE 3
           END,
           distance_in_miles ASC`,
      )
      .all(property_id) as any[]).map((r) => ({
      school_id: r.school_id,
      name: r.name,
      rating: r.rating,
      grades: r.grades,
      education_levels: r.education_levels,
      funding_type: r.funding_type,
      distance_in_miles: r.distance_in_miles,
      student_count: r.student_count,
    })),
  )
}

export function list_tax_history(property_id: number): any[] {
  return with_conn((conn) =>
    (conn
      .prepare(
        `SELECT year, assessed_year, tax,
                assessment_building, assessment_land, assessment_total,
                market_building, market_land, market_total,
                appraisal_building, appraisal_land, appraisal_total,
                value_building, value_land, value_total,
                tax_code_area
         FROM tax_history
         WHERE property_id = ?
         ORDER BY year ASC`,
      )
      .all(property_id) as any[]).map((r) => ({
      year: r.year,
      assessed_year: r.assessed_year,
      tax: r.tax,
      assessment_building: r.assessment_building,
      assessment_land: r.assessment_land,
      assessment_total: r.assessment_total,
      market_building: r.market_building,
      market_land: r.market_land,
      market_total: r.market_total,
      appraisal_building: r.appraisal_building,
      appraisal_land: r.appraisal_land,
      appraisal_total: r.appraisal_total,
      value_building: r.value_building,
      value_land: r.value_land,
      value_total: r.value_total,
      tax_code_area: r.tax_code_area,
    })),
  )
}
