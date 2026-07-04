// Ported from backend/test_browse.py. Pure aggregation tests + endpoint tests
// (via the HTTP dispatcher) over a throwaway DB.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import * as browse from '../browse'
import * as store from '../store'
import { handle_api } from '../api'
import { fresh_db } from './helpers'

function _listing(pid: any, overrides: any = {}): any {
  return {
    property_id: String(pid),
    line: `${pid} Main St`,
    city: 'Austin',
    state: 'TX',
    zip: '78704',
    list_price: 500000,
    beds: 3,
    baths: 2.0,
    sqft: 1500,
    year_built: 2000,
    days_on_market: 10,
    listing_state: 'for_sale',
    photo_url: null,
    ...overrides,
  }
}

function _fetched(overrides: any = {}): any {
  return {
    status: 'matched',
    matched_address: '4901 Bouldin Ave, Austin, TX 78704',
    city: 'Austin',
    state: 'TX',
    zip: '78704',
    property_id: 'TRACKED1',
    listing_id: 'listing-1',
    property_url: '/p/x',
    listing_state: 'for_sale',
    best_current_estimate: 700000,
    estimate_source: 'Cotality',
    ...overrides,
  }
}

// ---------- pure aggregation ----------
describe('build_pool', () => {
  it('unions zips and derives price_per_sqft', () => {
    const rows = [
      { zip: '78704', fetched_at: 200, listings: [_listing('A', { list_price: 600000, sqft: 2000 })] },
      { zip: '78745', fetched_at: 100, listings: [_listing('B', { list_price: 400000, sqft: 1000 })] },
    ]
    const pool = browse.build_pool(rows)
    const ids = new Set(pool.homes.map((h: any) => h.property_id))
    expect(ids).toEqual(new Set(['A', 'B']))
    expect(pool.zips).toEqual(['78704', '78745'])
    expect(pool.fetched_at).toBe(200)
    const by_id: any = Object.fromEntries(pool.homes.map((h: any) => [h.property_id, h]))
    expect(by_id.A.price_per_sqft).toBe(300)
    expect(by_id.B.price_per_sqft).toBe(400)
  })

  it('dedupes by property_id newest zip first', () => {
    const rows = [
      { zip: '78704', fetched_at: 200, listings: [_listing('DUP', { list_price: 600000 })] },
      { zip: '78745', fetched_at: 100, listings: [_listing('DUP', { list_price: 999999 })] },
    ]
    const pool = browse.build_pool(rows)
    expect(pool.homes.length).toBe(1)
    expect(pool.homes[0].list_price).toBe(600000)
  })

  it('excludes tracked property ids', () => {
    const rows = [{ zip: '78704', fetched_at: 1, listings: [_listing('KEEP'), _listing('DROP')] }]
    const pool = browse.build_pool(rows, new Set(['DROP']))
    expect(pool.homes.map((h: any) => h.property_id)).toEqual(['KEEP'])
  })

  it('skips listings without property_id', () => {
    const rows = [{ zip: '78704', fetched_at: 1, listings: [{ line: 'no id' }, _listing('OK')] }]
    const pool = browse.build_pool(rows)
    expect(pool.homes.map((h: any) => h.property_id)).toEqual(['OK'])
  })

  it('empty input', () => {
    const pool = browse.build_pool(null)
    expect(pool).toEqual({ homes: [], zips: [], fetched_at: null })
  })
})

describe('pool_facets', () => {
  it('bounds round outward and histogram sums', () => {
    const homes = [
      _listing('A', { list_price: 410000, sqft: 1450, year_built: 1990 }),
      _listing('B', { list_price: 980000, sqft: 2680, year_built: 2015 }),
      _listing('C', { list_price: 560000, sqft: 1820, year_built: 2004 }),
    ]
    const facets = browse.pool_facets(homes)
    expect(facets.count).toBe(3)
    expect(facets.bounds.price).toEqual([400000, 1000000])
    expect(facets.bounds.sqft).toEqual([1400, 2700])
    expect(facets.bounds.year).toEqual([1990, 2015])
    expect(facets.price_hist.length).toBe(24)
    expect(facets.price_hist.reduce((a: number, b: number) => a + b, 0)).toBe(3)
  })

  it('status counts and cities', () => {
    const homes = [
      _listing('A', { listing_state: 'for_sale', city: 'Austin' }),
      _listing('B', { listing_state: 'pending', city: 'Austin' }),
      _listing('C', { listing_state: 'for_sale', city: 'Round Rock' }),
    ]
    const facets = browse.pool_facets(homes)
    expect(facets.statuses).toEqual({ for_sale: 2, pending: 1 })
    expect(facets.cities).toEqual(['Austin', 'Round Rock'])
  })

  it('upper bounds capped at percentile not max', () => {
    const homes = Array.from({ length: 19 }, (_, i) =>
      _listing(i, { list_price: 400000 + i * 10000, sqft: 1400 + i * 20 }),
    )
    homes.push(_listing('MANSION', { list_price: 8_000_000, sqft: 12000 }))
    const facets = browse.pool_facets(homes)
    expect(facets.bounds.price[1]).toBeLessThan(1_000_000)
    expect(facets.bounds.sqft[1]).toBeLessThan(3_000)
    expect(facets.bounds.price[0]).toBe(400_000)
  })

  it('year lower bound floored at percentile not min', () => {
    const homes = Array.from({ length: 19 }, (_, i) => _listing(i, { year_built: 1985 + i }))
    homes.push(_listing('OLD', { year_built: 1890 }))
    const facets = browse.pool_facets(homes)
    expect(facets.bounds.year[0]).toBeGreaterThan(1900)
    expect(facets.bounds.year[1]).toBe(2003)
  })

  it('empty pool falls back to default bounds', () => {
    const facets = browse.pool_facets([])
    expect(facets.count).toBe(0)
    expect(facets.bounds.price).toEqual([200_000, 1_500_000])
    expect(facets.price_hist.reduce((a: number, b: number) => a + b, 0)).toBe(0)
  })
})

// ---------- endpoint: reads cache only, excludes tracked ----------
async function get_browse_json(): Promise<any> {
  const resp = await handle_api(new Request('http://local/api/browse'))
  return resp.json()
}

describe('browse endpoint', () => {
  beforeEach(() => {
    fresh_db()
  })

  it('empty cache returns empty pool', async () => {
    const res = await get_browse_json()
    expect(res.total).toBe(0)
    expect(res.homes).toEqual([])
    expect(res.zips).toEqual([])
  })

  it('aggregates cache and excludes tracked', async () => {
    store.create_property('4901 Bouldin Ave, Austin, TX 78704', _fetched({ property_id: 'TRACKED1' }))
    store.upsert_area_listings('78704', [
      _listing('TRACKED1', { list_price: 700000 }),
      _listing('FREE1', { list_price: 450000, sqft: 1500 }),
    ])
    store.upsert_area_listings('78745', [_listing('FREE2', { list_price: 525000, sqft: 1750, city: 'Austin' })])

    const res = await get_browse_json()
    const ids = new Set(res.homes.map((h: any) => h.property_id))
    expect(ids).toEqual(new Set(['FREE1', 'FREE2']))
    expect(res.total).toBe(2)
    expect(new Set(res.zips)).toEqual(new Set(['78704', '78745']))
    expect('price' in res.bounds).toBe(true)
    expect(res.price_hist.length).toBe(24)
    expect(res.homes.find((h: any) => h.property_id === 'FREE1').price_per_sqft).toBe(300)
  })

  it('never calls realtor (no network on browse)', async () => {
    store.upsert_area_listings('78704', [_listing('FREE1')])
    const spy = vi.spyOn(globalThis, 'fetch')
    await get_browse_json()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})
