// API dispatcher — ported from backend/app/main.py. All /api/* requests land here.
// Route shapes, status codes, and {detail} error bodies must stay byte-compatible
// with the FastAPI contract in AGENTS.md (the Chrome extension is a client too).

import * as ai from './ai'
import * as browse from './browse'
import * as comps from './comps'
import * as rates from './rates'
import * as scraper from './scraper'
import * as store from './store'
import { init_db } from './db'

const CORS_HEADERS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type',
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS_HEADERS },
  })
}

class HTTPError extends Error {
  status: number
  constructor(status: number, detail: string) {
    super(detail)
    this.status = status
  }
}

const ZIP_RE = /^\d{5}$/

async function read_body(request: Request): Promise<any> {
  try {
    return await request.json()
  } catch {
    throw new HTTPError(422, 'invalid JSON body')
  }
}

function parse_pid(raw: string): number {
  const pid = Number(raw)
  if (!Number.isInteger(pid)) throw new HTTPError(422, 'invalid property id')
  return pid
}

function _property_with_related(pid: number): any | null {
  const prop = store.get_property(pid)
  if (!prop) return null
  prop.historical = store.list_historical(pid)
  prop.events = store.list_events(pid)
  prop.tax_history = store.list_tax_history(pid)
  prop.schools = store.list_schools(pid)
  prop.photos = scraper.extract_photos(prop.raw_json)
  return prop
}

async function _backfill_history(pid: number, property_id: string | null): Promise<any> {
  if (!property_id) {
    return { id: pid, written: 0, events_written: 0, taxes_written: 0, error: 'no property_id on record' }
  }
  let bundle: any
  try {
    bundle = await scraper.fetch_history_bundle(property_id)
  } catch (e: any) {
    return {
      id: pid,
      written: 0,
      events_written: 0,
      taxes_written: 0,
      error: `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}`,
    }
  }
  const written = store.replace_historical(pid, bundle.estimates)
  const events_written = store.replace_events(pid, bundle.events)
  const taxes_written = store.replace_tax_history(pid, bundle.taxes ?? [])
  return { id: pid, written, events_written, taxes_written, error: null }
}

function _area_record(zip_code: string): any | null {
  return store.list_area_coverage().find((r: any) => r.zip === zip_code) ?? null
}

// ---------- handlers ----------

async function get_property_route(pid: number): Promise<Response> {
  const p = _property_with_related(pid)
  if (!p) throw new HTTPError(404, 'property not found')
  return json(p)
}

async function ask_property_ai(pid: number, request: Request): Promise<Response> {
  const body = await read_body(request)
  const question = String(body?.question ?? '').trim()
  if (!question) throw new HTTPError(400, 'question is required')
  const settings = store.get_ai_settings()
  if (!settings.enabled) throw new HTTPError(403, 'AI features are disabled')
  if (!settings.has_deepseek_api_key) throw new HTTPError(400, 'DEEPSEEK_API_KEY is not configured')
  const prop = _property_with_related(pid)
  if (!prop) throw new HTTPError(404, 'property not found')
  try {
    return json(await ai.answer_property_question(prop, question))
  } catch (e: any) {
    if (e instanceof ai.AIError) throw new HTTPError(502, e.message)
    throw e
  }
}

async function update_property(pid: number, request: Request): Promise<Response> {
  const body = await read_body(request)
  const allowed = ['property_name', 'input_address', 'canonical_address', 'city', 'state', 'zip', 'active', 'pinned']
  const changes: any = {}
  for (const key of allowed) {
    if (body && Object.prototype.hasOwnProperty.call(body, key)) changes[key] = body[key]
  }
  if (Object.keys(changes).length === 0) {
    const prop = store.get_property(pid)
    if (!prop) throw new HTTPError(404, 'property not found')
    return json(prop)
  }
  let prop: any
  try {
    prop = store.update_property(pid, changes)
  } catch (e: any) {
    if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) {
      throw new HTTPError(409, 'another property already uses that canonical address')
    }
    if (e instanceof Error && (e as any).code === undefined) throw new HTTPError(400, e.message)
    throw e
  }
  if (!prop) throw new HTTPError(404, 'property not found')
  return json(_property_with_related(pid))
}

async function add_property(request: Request): Promise<Response> {
  const body = await read_body(request)
  const address = String(body?.address ?? '')
  const confirm_mismatch = Boolean(body?.confirm_mismatch ?? false)

  const fetched = await scraper.fetch_property(address)
  const status = fetched.status

  if (status === 'error') {
    return json({ status: 'error', error: fetched.error ?? null, property: null, candidate: null })
  }
  if (status === 'no_candidates') {
    return json({ status: 'no_candidates', error: null, property: null, candidate: null })
  }

  let existing = store.find_property_by_address(address)
  if (!existing && fetched.matched_address) {
    existing = store.find_property_by_address(fetched.matched_address)
  }

  if (status === 'candidate_mismatch' && !confirm_mismatch && !existing) {
    return json({
      status: 'candidate_mismatch',
      property: null,
      candidate: {
        input_address: address,
        matched_address: fetched.matched_address ?? null,
        best_current_estimate: fetched.best_current_estimate ?? null,
        estimate_source: fetched.estimate_source ?? null,
        estimate_low: fetched.estimate_low ?? null,
        estimate_high: fetched.estimate_high ?? null,
        list_price: fetched.list_price ?? null,
        listing_state: fetched.listing_state ?? null,
        beds: fetched.beds ?? null,
        baths: fetched.baths ?? null,
        sqft: fetched.sqft ?? null,
        year_built: fetched.year_built ?? null,
      },
      error: null,
    })
  }

  let prop: any
  if (existing) {
    store.update_property_meta(existing.id, fetched)
    store.set_property_active(existing.id, true)
    prop = store.get_property(existing.id)
  } else {
    prop = store.create_property(address, fetched)
  }

  const backfill = await _backfill_history(prop.id, prop.property_id ?? null)
  prop = _property_with_related(prop.id)
  if (prop.zip) {
    await store.refresh_area_for_zip(prop.zip)
  }
  return json({ status, property: prop, candidate: null, error: null, backfill })
}

function get_property_area(pid: number, url: URL): Response {
  const prop = store.get_property(pid)
  if (!prop) throw new HTTPError(404, 'property not found')
  const zip_code = prop.zip
  if (!zip_code) {
    return json({
      zip: null,
      fetched_at: null,
      comps: [],
      relaxed: null,
      limited: false,
      subject_price_per_sqft: null,
      domain: { prices: [], sqfts: [], count: 0 },
    })
  }
  const num = (name: string) => {
    const raw = url.searchParams.get(name)
    if (raw === null || raw === '') return null
    const v = Number(raw)
    return Number.isFinite(v) ? v : null
  }
  const area = store.get_area_listings(zip_code)
  const subject = String(prop.property_id ?? '')
  const candidates = (area.listings as any[]).filter((l) => String(l.property_id ?? '') !== subject)
  const filters = {
    min_price: num('min_price'),
    max_price: num('max_price'),
    min_beds: num('min_beds'),
    min_baths: num('min_baths'),
    min_sqft: num('min_sqft'),
    max_sqft: num('max_sqft'),
  }
  const ranked = comps.rank_comparables(prop, candidates, filters)
  return json({
    zip: area.zip,
    fetched_at: area.fetched_at,
    comps: ranked.comps,
    relaxed: ranked.relaxed,
    limited: ranked.limited,
    subject_price_per_sqft: ranked.subject_price_per_sqft,
    domain: comps.comp_domain(prop, candidates),
  })
}

function get_browse(): Response {
  const area_rows = store.get_all_area_listings().filter((r: any) => r.status !== 'paused')
  const tracked_ids = new Set(
    store
      .list_properties()
      .filter((p: any) => p.property_id)
      .map((p: any) => String(p.property_id)),
  )
  const pool = browse.build_pool(area_rows, tracked_ids)
  const facets = browse.pool_facets(pool.homes)
  return json({
    homes: pool.homes,
    total: facets.count,
    zips: pool.zips,
    fetched_at: pool.fetched_at,
    cities: facets.cities,
    statuses: facets.statuses,
    bounds: facets.bounds,
    price_hist: facets.price_hist,
  })
}

async function add_area(request: Request): Promise<Response> {
  const body = await read_body(request)
  const zip_code = String(body?.zip ?? '').trim()
  if (!ZIP_RE.test(zip_code)) throw new HTTPError(400, 'Enter a full 5-digit ZIP code')
  if (store.area_zip_exists(zip_code)) throw new HTTPError(409, `${zip_code} is already tracked`)
  try {
    await store.crawl_area_zip(zip_code)
  } catch (e: any) {
    throw new HTTPError(502, `Couldn't crawl ${zip_code}: ${e?.message ?? e}`)
  }
  return json(_area_record(zip_code))
}

async function recrawl_area(zip_raw: string): Promise<Response> {
  const zip_code = (zip_raw || '').trim()
  if (!store.area_zip_exists(zip_code)) throw new HTTPError(404, 'ZIP is not tracked')
  try {
    await store.crawl_area_zip(zip_code)
  } catch (e: any) {
    throw new HTTPError(502, `Couldn't re-crawl ${zip_code}: ${e?.message ?? e}`)
  }
  return json(_area_record(zip_code))
}

async function update_area(zip_raw: string, request: Request): Promise<Response> {
  const body = await read_body(request)
  const zip_code = (zip_raw || '').trim()
  const status = body?.status
  if (status !== 'active' && status !== 'paused') {
    throw new HTTPError(400, "status must be 'active' or 'paused'")
  }
  if (!store.set_area_status(zip_code, status)) throw new HTTPError(404, 'ZIP is not tracked')
  return json(_area_record(zip_code))
}

function remove_area(zip_raw: string): Response {
  const zip_code = (zip_raw || '').trim()
  const record = _area_record(zip_code)
  if (!record) throw new HTTPError(404, 'ZIP is not tracked')
  if (record.locked) {
    throw new HTTPError(409, 'This ZIP backs a property you track — remove that property first')
  }
  store.delete_area_listings(zip_code)
  return json({ ok: true, zip: zip_code })
}

async function create_saved_search(request: Request): Promise<Response> {
  const body = await read_body(request)
  if (typeof body?.name !== 'string') throw new HTTPError(422, 'name is required')
  return json(store.create_saved_search(body.name, body.filters ?? {}))
}

async function refresh_property(pid: number): Promise<Response> {
  const prop = store.get_property(pid)
  if (!prop) throw new HTTPError(404, 'property not found')
  const addr = prop.canonical_address || prop.input_address
  const fetched = await scraper.fetch_property(addr)
  store.update_property_meta(pid, fetched)
  const zip_code = fetched.zip || prop.zip
  if (zip_code) {
    await store.refresh_area_for_zip(zip_code)
  }
  return json(_property_with_related(pid))
}

async function refresh_all(): Promise<Response> {
  const props = store.list_properties().filter((p: any) => p.active !== false)
  const results: any[] = []
  const zips = new Set<string>()
  for (const p of props) {
    const addr = p.canonical_address || p.input_address
    const fetched = await scraper.fetch_property(addr)
    const observed_event = store.update_property_meta(p.id, fetched)
    const zip_code = fetched.zip || p.zip
    if (zip_code) zips.add(zip_code)
    results.push({ id: p.id, status: store.persisted_status(fetched), observed_event })
  }
  // One area fetch per unique ZIP, not per property.
  for (const zip_code of zips) {
    await store.refresh_area_for_zip(zip_code)
  }
  return json({ refreshed: results.length, results, areas_refreshed: zips.size })
}

async function backfill_all(): Promise<Response> {
  const props = store.list_properties()
  const results: any[] = []
  for (const p of props) {
    results.push(await _backfill_history(p.id, p.property_id ?? null))
  }
  return json({ backfilled: results.filter((r) => r.error === null).length, results })
}

async function update_ai_settings(request: Request): Promise<Response> {
  const body = await read_body(request)
  const changes: any = {}
  if (body && Object.prototype.hasOwnProperty.call(body, 'enabled')) changes.enabled = body.enabled
  return json(store.save_ai_settings(changes))
}

// ---------- dispatch ----------

let initialized = false

export async function handle_api(request: Request): Promise<Response> {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (!initialized) {
    init_db()
    initialized = true
  }

  const url = new URL(request.url)
  const path = url.pathname.replace(/\/+$/, '') || url.pathname
  const method = request.method

  try {
    return await dispatch(method, path, url, request)
  } catch (e: any) {
    if (e instanceof HTTPError) return json({ detail: e.message }, e.status)
    console.error(`API error on ${method} ${path}:`, e)
    return json({ detail: 'Internal Server Error' }, 500)
  }
}

async function dispatch(method: string, path: string, url: URL, request: Request): Promise<Response> {
  // Fixed paths first (so refresh-all/backfill-all don't parse as {pid}).
  if (path === '/api/properties') {
    if (method === 'GET') return json(store.list_properties())
    if (method === 'POST') return add_property(request)
  }
  if (path === '/api/properties/refresh-all' && method === 'POST') return refresh_all()
  if (path === '/api/properties/backfill-all' && method === 'POST') return backfill_all()
  if (path === '/api/mortgage-rates' && method === 'GET') return json(await rates.get_mortgage_rates())
  if (path === '/api/browse' && method === 'GET') return get_browse()

  if (path === '/api/admin/ai-settings') {
    if (method === 'GET') return json(store.get_ai_settings())
    if (method === 'PATCH') return update_ai_settings(request)
  }
  if (path === '/api/admin/areas') {
    if (method === 'GET') return json(store.list_area_coverage())
    if (method === 'POST') return add_area(request)
  }

  let m = path.match(/^\/api\/admin\/areas\/([^/]+)\/recrawl$/)
  if (m && method === 'POST') return recrawl_area(decodeURIComponent(m[1]))
  m = path.match(/^\/api\/admin\/areas\/([^/]+)$/)
  if (m) {
    if (method === 'PATCH') return update_area(decodeURIComponent(m[1]), request)
    if (method === 'DELETE') return remove_area(decodeURIComponent(m[1]))
  }

  if (path === '/api/saved-searches') {
    if (method === 'GET') return json(store.list_saved_searches())
    if (method === 'POST') return create_saved_search(request)
  }
  m = path.match(/^\/api\/saved-searches\/([^/]+)$/)
  if (m && method === 'DELETE') {
    const search_id = decodeURIComponent(m[1])
    if (!store.delete_saved_search(search_id)) throw new HTTPError(404, 'Saved search not found')
    return json({ ok: true, id: search_id })
  }

  m = path.match(/^\/api\/properties\/([^/]+)$/)
  if (m) {
    const pid = parse_pid(m[1])
    if (method === 'GET') return get_property_route(pid)
    if (method === 'PATCH') return update_property(pid, request)
    if (method === 'DELETE') {
      if (!store.delete_property(pid)) throw new HTTPError(404, 'property not found')
      return json({ deleted: true, id: pid })
    }
  }

  m = path.match(/^\/api\/properties\/([^/]+)\/([a-z-]+(?:\/[a-z-]+)?)$/)
  if (m) {
    const pid = parse_pid(m[1])
    const action = m[2]
    if (action === 'area' && method === 'GET') return get_property_area(pid, url)
    if (action === 'ai/ask' && method === 'POST') return ask_property_ai(pid, request)
    if (method === 'POST') {
      if (action === 'archive') {
        if (!store.set_property_active(pid, false)) throw new HTTPError(404, 'property not found')
        return json(_property_with_related(pid))
      }
      if (action === 'restore') {
        if (!store.set_property_active(pid, true)) throw new HTTPError(404, 'property not found')
        return json(_property_with_related(pid))
      }
      if (action === 'refresh') return refresh_property(pid)
      if (action === 'backfill') {
        const prop = store.get_property(pid)
        if (!prop) throw new HTTPError(404, 'property not found')
        return json(await _backfill_history(pid, prop.property_id ?? null))
      }
    }
  }

  throw new HTTPError(404, 'Not Found')
}
