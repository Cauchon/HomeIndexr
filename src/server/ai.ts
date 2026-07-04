// DeepSeek chat + tool-calling loop — ported from backend/app/ai.py.
// Grounds answers in local property context; can call web_search (Brave) and
// geocoding (Nominatim) tools. Secrets come from the environment/.env only
// (AGENTS.md rule #13). MAX_TOOL_STEPS / MAX_WEB_SEARCHES cap upstream usage.

import * as store from './store'

export class AIError extends Error {}

// Cap on how many times the model may call tools before we force a final answer.
export const MAX_TOOL_STEPS = 4
const WEB_SEARCH_TIMEOUT = 20
const GEOCODE_TIMEOUT = 20
const CHAT_TIMEOUT = 45

// Hard ceiling on Brave web_search calls per question (bounds Brave usage that
// MAX_TOOL_STEPS alone does not — a tool round can contain several searches).
export const MAX_WEB_SEARCHES = 5
// Brave's free tier rate-limits ~1 query/second; retry once on a 429.
const WEB_SEARCH_MAX_RETRIES = 1
const WEB_SEARCH_RETRY_WAIT = 1.2

// When we cut the model off at the tool-call limit we must force a prose answer;
// reasoning models otherwise leak tool-call markup into content. See ai.py.
const _FINAL_ANSWER_DIRECTIVE =
  'Stop searching. Using only the information you have already gathered, write ' +
  'your final answer now in plain Markdown prose. Do NOT call any tools or emit ' +
  'any tool-call markup.'

// Defensive guard: if leaked tool-call markup still reaches us, never show it.
const _TOOL_MARKUP_RE = /DSML|invoke name=|tool_calls/i

function _looks_like_tool_markup(text: string | null | undefined): boolean {
  return Boolean(text) && _TOOL_MARKUP_RE.test(text as string)
}

function sleep(seconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, seconds * 1000))
}

function _clean_obj(value: any): any {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const out: any = {}
    for (const [k, v] of Object.entries(value)) {
      if (v !== null && v !== undefined) out[k] = _clean_obj(v)
    }
    return out
  }
  if (Array.isArray(value)) return value.map(_clean_obj)
  return value
}

function _take_sorted(rows: any[], key: string, limit: number): any[] {
  const arr = (rows || []).map((r, i) => [r, i] as [any, number])
  arr.sort((A, B) => {
    const a = String(A[0]?.[key] ?? '')
    const b = String(B[0]?.[key] ?? '')
    if (a < b) return 1 // reverse=True → descending
    if (a > b) return -1
    return A[1] - B[1]
  })
  return arr.slice(0, limit).map((x) => x[0])
}

// Deterministic JSON with sorted keys, mirroring json.dumps(sort_keys=True).
function _sort_keys_deep(v: any): any {
  if (Array.isArray(v)) return v.map(_sort_keys_deep)
  if (v !== null && typeof v === 'object') {
    const out: any = {}
    for (const k of Object.keys(v).sort()) out[k] = _sort_keys_deep(v[k])
    return out
  }
  return v
}

export function build_property_context(prop: any): any {
  const raw = prop.raw_json && typeof prop.raw_json === 'object' && !Array.isArray(prop.raw_json) ? prop.raw_json : {}
  const raw_location = raw.location && typeof raw.location === 'object' ? raw.location : {}
  const context = {
    property: {
      id: prop.id,
      name: prop.property_name,
      address: prop.canonical_address || prop.input_address,
      city: prop.city,
      state: prop.state,
      zip: prop.zip,
      latitude: prop.latitude,
      longitude: prop.longitude,
      listing_state: prop.listing_state,
      property_url: prop.property_url,
      last_fetched_at_ms: prop.last_fetched_at,
    },
    current_values: {
      best_current_estimate: prop.best_current_estimate,
      estimate_source: prop.estimate_source,
      estimate_low: prop.estimate_low,
      estimate_high: prop.estimate_high,
      estimate_date: prop.estimate_date,
      list_price: prop.list_price,
      sold_price: prop.sold_price,
      last_sold_price: prop.last_sold_price,
      list_date: prop.list_date,
      days_on_market: prop.days_on_market,
      last_price_change_amount: prop.last_price_change_amount,
      last_price_change_date: prop.last_price_change_date,
    },
    facts: {
      beds: prop.beds,
      baths: prop.baths,
      sqft: prop.sqft,
      lot_sqft: prop.lot_sqft,
      year_built: prop.year_built,
      property_type: prop.property_type,
      property_sub_type: prop.property_sub_type,
      hoa_fee: prop.hoa_fee,
      flood_factor_score: prop.flood_factor_score,
      flood_factor_severity: prop.flood_factor_severity,
    },
    current_estimates: prop.all_estimates || [],
    // Full historical series (chronological), not a recent slice — the series
    // interleaves two sources, so an N-row cap silently halves the visible span.
    historical_estimates: [...(prop.historical || [])].sort((a, b) => {
      const x = String(a?.date ?? '')
      const y = String(b?.date ?? '')
      return x < y ? -1 : x > y ? 1 : 0
    }),
    market_and_observed_events_recent: _take_sorted(prop.events || [], 'date', 36),
    tax_history_recent: _take_sorted(prop.tax_history || [], 'year', 8),
    schools: prop.schools || [],
    raw_realtor: {
      status: raw.status,
      list_price: raw.list_price,
      description: raw.description || raw.text,
      location: raw_location.address || raw_location,
      top_level_keys: Object.keys(raw).sort().slice(0, 80),
    },
  }
  return _clean_obj(context)
}

// ---------- tools ----------

function _tool_specs(has_web_search: boolean): any[] {
  const specs: any[] = []
  if (has_web_search) {
    specs.push({
      type: 'function',
      function: {
        name: 'web_search',
        description:
          'Search the public web for facts not present in the supplied ' +
          'property data — neighborhood name, school boundaries, local ' +
          'market trends, nearby amenities, recent news. Returns titles, ' +
          'URLs, and snippets. Always cite the URLs you use.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query.' },
            count: { type: 'integer', description: 'Number of results (1-10, default 5).' },
          },
          required: ['query'],
        },
      },
    })
  }
  specs.push({
    type: 'function',
    function: {
      name: 'reverse_geocode',
      description:
        'Resolve a latitude/longitude to a place: neighborhood, suburb, ' +
        "city, county, state, postcode. Use this to answer 'what " +
        "neighborhood/area is this in'. Defaults to the property's own " +
        'coordinates when lat/lon are omitted.',
      parameters: {
        type: 'object',
        properties: {
          lat: { type: 'number', description: 'Latitude.' },
          lon: { type: 'number', description: 'Longitude.' },
        },
      },
    },
  })
  specs.push({
    type: 'function',
    function: {
      name: 'geocode_address',
      description:
        'Resolve a free-text address to coordinates and structured ' +
        'address parts (neighborhood, county, etc.). Use when you only ' +
        'have an address string and need its location.',
      parameters: {
        type: 'object',
        properties: {
          address: { type: 'string', description: 'Address to look up.' },
        },
        required: ['address'],
      },
    },
  })
  return specs
}

async function _web_search(query: string, count: any = 5): Promise<any> {
  const key = store.get_brave_api_key()
  if (!key) return { error: 'web search is not configured' }
  count = Math.max(1, Math.min(Math.trunc(Number(count) || 5), 10))
  const url = `${store.get_brave_api_base()}/web/search`
  const headers = { Accept: 'application/json', 'X-Subscription-Token': key }
  const params = new URLSearchParams({ q: query, count: String(count) })
  let res: Response
  for (let attempt = 0; attempt <= WEB_SEARCH_MAX_RETRIES; attempt++) {
    try {
      res = await fetch(`${url}?${params.toString()}`, {
        headers,
        signal: AbortSignal.timeout(WEB_SEARCH_TIMEOUT * 1000),
      })
    } catch (e: any) {
      return { error: `web search request failed: ${e?.message ?? e}` }
    }
    // Back off and retry once on a rate-limit response (free tier: 1 query/s).
    if (res.status === 429 && attempt < WEB_SEARCH_MAX_RETRIES) {
      await sleep(WEB_SEARCH_RETRY_WAIT)
      continue
    }
    break
  }
  if (!res!.ok) {
    const detail = (await res!.text()).slice(0, 200)
    return { error: `web search HTTP ${res!.status}`, detail }
  }
  const text = await res!.text()
  const data = text ? JSON.parse(text) : {}
  const results = data?.web?.results || []
  const trimmed = results.slice(0, count).map((r: any) => ({
    title: r.title ?? null,
    url: r.url ?? null,
    description: r.description ?? null,
  }))
  return { query, results: trimmed }
}

async function _geocoder_get(path: string, params: Record<string, any>): Promise<any> {
  let res: Response
  const qs = new URLSearchParams({ ...params, format: 'jsonv2', addressdetails: '1' } as any)
  try {
    res = await fetch(`${store.get_geocoder_base()}${path}?${qs.toString()}`, {
      headers: { 'User-Agent': store.get_geocoder_user_agent() },
      signal: AbortSignal.timeout(GEOCODE_TIMEOUT * 1000),
    })
  } catch (e: any) {
    return { error: `geocoder request failed: ${e?.message ?? e}` }
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 200)
    return { error: `geocoder HTTP ${res.status}`, detail }
  }
  const text = await res.text()
  return text ? JSON.parse(text) : {}
}

function _format_place(entry: any): any {
  const addr = entry.address || {}
  return {
    display_name: entry.display_name ?? null,
    lat: entry.lat ?? null,
    lon: entry.lon ?? null,
    neighborhood: addr.neighbourhood || addr.suburb || addr.quarter || null,
    suburb: addr.suburb ?? null,
    city: addr.city || addr.town || addr.village || null,
    county: addr.county ?? null,
    state: addr.state ?? null,
    postcode: addr.postcode ?? null,
  }
}

async function _reverse_geocode(prop: any, lat: any = null, lon: any = null): Promise<any> {
  lat = lat !== null && lat !== undefined ? lat : prop.latitude
  lon = lon !== null && lon !== undefined ? lon : prop.longitude
  if (lat === null || lat === undefined || lon === null || lon === undefined) {
    return { error: 'no coordinates available for this property' }
  }
  const data = await _geocoder_get('/reverse', { lat, lon })
  if (data && data.error) return data
  return _format_place(data)
}

async function _geocode_address(address: any): Promise<any> {
  if (!address || !String(address).trim()) return { error: 'address is required' }
  const data = await _geocoder_get('/search', { q: String(address).trim(), limit: 1 })
  if (data && !Array.isArray(data) && data.error) return data
  if (!Array.isArray(data) || !data.length) return { error: 'no geocoding match' }
  return _format_place(data[0])
}

async function _dispatch_tool(prop: any, name: string, args: any): Promise<any> {
  try {
    if (name === 'web_search') return await _web_search(args.query ?? '', args.count ?? 5)
    if (name === 'reverse_geocode') return await _reverse_geocode(prop, args.lat, args.lon)
    if (name === 'geocode_address') return await _geocode_address(args.address ?? '')
  } catch (e: any) {
    return { error: `${e?.constructor?.name ?? 'Error'}: ${e?.message ?? e}` }
  }
  return { error: `unknown tool: ${name}` }
}

function _accumulate_usage(total: any, usage: any): void {
  for (const k of ['prompt_tokens', 'completion_tokens', 'total_tokens']) {
    if (usage[k] !== null && usage[k] !== undefined) {
      total[k] = (total[k] || 0) + Math.trunc(usage[k])
    }
  }
}

async function _chat_completion(base: string, api_key: string, payload: any): Promise<any> {
  let res: Response
  try {
    res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${api_key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CHAT_TIMEOUT * 1000),
    })
  } catch (e: any) {
    throw new AIError(`DeepSeek request failed: ${e?.message ?? e}`)
  }
  if (!res.ok) {
    const body = (await res.text()).slice(0, 500)
    throw new AIError(`DeepSeek returned HTTP ${res.status}: ${body}`)
  }
  return res.json()
}

export async function answer_property_question(prop: any, question: string): Promise<any> {
  const api_key = store.get_deepseek_api_key()
  if (!api_key) throw new AIError('DeepSeek API key is not configured')

  const model = store.get_deepseek_model()
  const base = store.get_deepseek_api_base()
  const context = build_property_context(prop)
  const has_web_search = Boolean(store.get_brave_api_key())
  const tools = _tool_specs(has_web_search)

  const tool_lines = [
    '- reverse_geocode / geocode_address: resolve coordinates or an address to a ' +
      'neighborhood, county, and place name.',
  ]
  if (has_web_search) {
    tool_lines.unshift(
      "- web_search: look up public facts that aren't in the data (neighborhood, " +
        'schools, local market, amenities, news). Limited to ' +
        `${MAX_WEB_SEARCHES} searches per question, so make each query count.`,
    )
  }

  const system =
    "You are HomeIndexr's property research assistant. Answer using the supplied " +
    'local property data first: current values, historical estimates, market events, ' +
    'observed refresh events, taxes, schools, and the Realtor raw data. Be direct. ' +
    'Do not claim causality when the data only supports correlation.\n\n' +
    'When the supplied data cannot answer the question, USE YOUR TOOLS to look it up ' +
    'rather than telling the user to check elsewhere:\n' +
    tool_lines.join('\n') +
    "\n\nCite specific tool results (including URLs from web_search) in a short " +
    "'Evidence used' section listing the rows, fields, or sources you relied on."

  const messages: any[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content:
        'Question:\n' +
        `${question.trim()}\n\n` +
        'Property data JSON:\n' +
        `${JSON.stringify(_sort_keys_deep(context))}`,
    },
  ]

  const usage_total: any = {}
  const tools_used: string[] = []
  let web_searches_used = 0

  for (let step = 0; step < MAX_TOOL_STEPS + 1; step++) {
    const offering_tools = Boolean(tools.length) && step < MAX_TOOL_STEPS
    // On the final allowed step we drop tools to force an answer, and instruct
    // the model — once — to answer in prose. See _FINAL_ANSWER_DIRECTIVE.
    if (tools.length && step === MAX_TOOL_STEPS) {
      messages.push({ role: 'user', content: _FINAL_ANSWER_DIRECTIVE })
    }

    const payload: any = {
      model,
      messages,
      temperature: 0.2,
      max_tokens: 900,
      stream: false,
    }
    if (offering_tools) {
      payload.tools = tools
      payload.tool_choice = 'auto'
    }

    const data = await _chat_completion(base, api_key, payload)
    _accumulate_usage(usage_total, data.usage || {})
    let message: any
    try {
      message = data.choices[0].message
    } catch (e) {
      throw new AIError('DeepSeek returned an unexpected response')
    }
    if (!message) throw new AIError('DeepSeek returned an unexpected response')

    const tool_calls = message.tool_calls || []
    if (!tool_calls.length) {
      let answer = message.content || ''
      // Safety net: never surface raw leaked tool-call markup to the user.
      if (_looks_like_tool_markup(answer)) {
        answer =
          'I gathered web and location data but couldn\'t compose a final ' +
          'summary this time. Please ask again.'
      }
      return {
        answer,
        model: data.model || model,
        usage: usage_total,
        tools_used,
        context: {
          historical_estimates: (context.historical_estimates || []).length,
          events: (context.market_and_observed_events_recent || []).length,
          tax_rows: (context.tax_history_recent || []).length,
          schools: (context.schools || []).length,
          web_search_enabled: has_web_search,
        },
      }
    }

    // Echo the assistant tool-call message back, then append each tool result.
    messages.push(message)
    for (const call of tool_calls) {
      const fn = call.function || {}
      const name = fn.name || ''
      let args: any
      try {
        args = JSON.parse(fn.arguments || '{}')
      } catch {
        args = {}
      }
      // Enforce the per-question Brave budget without hitting the API.
      let result: any
      if (name === 'web_search' && web_searches_used >= MAX_WEB_SEARCHES) {
        result = {
          error:
            `web search budget reached (${MAX_WEB_SEARCHES} per question); ` +
            'answer using the results you already have',
        }
      } else {
        result = await _dispatch_tool(prop, name, args)
        if (name === 'web_search') web_searches_used += 1
      }
      if (name && !tools_used.includes(name)) tools_used.push(name)
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result),
      })
    }
  }

  throw new AIError('AI did not produce an answer within the tool-call limit')
}
