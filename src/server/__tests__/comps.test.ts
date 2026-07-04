// Ported from backend/test_comps.py. Pure module — no DB, no network.
import { describe, it, expect } from 'vitest'
import * as comps from '../comps'

function _subject(overrides: any = {}): any {
  return {
    property_type: 'single_family',
    beds: 4,
    baths: 3.0,
    sqft: 2000,
    lot_sqft: 8000,
    year_built: 2000,
    latitude: 29.0,
    longitude: -95.0,
    list_price: 600000,
    ...overrides,
  }
}

function _listing(pid: string, overrides: any = {}): any {
  return { property_id: pid, ...overrides }
}

describe('haversine_miles', () => {
  it('zero distance', () => {
    expect(comps.haversine_miles(29.0, -95.0, 29.0, -95.0)).toBe(0.0)
  })
  it('one degree latitude is about 69 miles', () => {
    const d = comps.haversine_miles(0.0, 0.0, 1.0, 0.0)!
    expect(Math.abs(d - 69.09)).toBeLessThan(0.5)
  })
  it('missing coordinate returns null', () => {
    expect(comps.haversine_miles(29.0, null, 29.0, -95.0)).toBeNull()
  })
})

describe('price_per_sqft', () => {
  it('rounds', () => {
    expect(comps.price_per_sqft(610000, 2050)).toBe(298)
  })
  it('missing sqft returns null', () => {
    expect(comps.price_per_sqft(600000, null)).toBeNull()
    expect(comps.price_per_sqft(600000, 0)).toBeNull()
  })
})

describe('gates', () => {
  it('missing sqft candidate excluded when others qualify', () => {
    const res = comps.rank_comparables(_subject(), [
      _listing('nosqft', { property_type: 'single_family', beds: 4, list_price: 500000 }),
      _listing('good', { property_type: 'single_family', beds: 4, sqft: 2100, list_price: 610000 }),
    ])
    expect(res.comps.map((c: any) => c.property_id)).toEqual(['good'])
    expect(res.relaxed).toBeNull()
  })
  it('oversized excluded by sqft gate', () => {
    const res = comps.rank_comparables(_subject({ sqft: 2000 }), [
      _listing('big', { property_type: 'single_family', beds: 4, sqft: 3000, list_price: 900000 }),
      _listing('ok', { property_type: 'single_family', beds: 4, sqft: 2200, list_price: 650000 }),
    ])
    expect(res.comps.map((c: any) => c.property_id)).toEqual(['ok'])
  })
})

describe('ranking', () => {
  it('closer match ranks first', () => {
    const res = comps.rank_comparables(_subject(), [
      _listing('far', {
        property_type: 'single_family', beds: 5, sqft: 2400,
        year_built: 1980, latitude: 29.04, longitude: -95.04, list_price: 700000,
      }),
      _listing('near', {
        property_type: 'single_family', beds: 4, sqft: 2010,
        year_built: 2001, latitude: 29.001, longitude: -95.001, list_price: 605000,
      }),
    ])
    expect(res.comps.map((c: any) => c.property_id)).toEqual(['near', 'far'])
    expect(res.comps[0].comp_score).toBeGreaterThan(res.comps[1].comp_score)
    expect(res.comps[0].distance_mi).not.toBeNull()
  })
  it('limit caps results', () => {
    const listings = Array.from({ length: 10 }, (_, i) =>
      _listing(`c${i}`, { property_type: 'single_family', beds: 4, sqft: 2000 + i * 10, list_price: 600000 }),
    )
    const res = comps.rank_comparables(_subject(), listings, null, 6)
    expect(res.comps.length).toBe(6)
  })
})

describe('fallback', () => {
  it('falls back to nearest when no strict comps', () => {
    const res = comps.rank_comparables(_subject({ sqft: 2000 }), [
      _listing('condo', { property_type: 'condo', sqft: 2000, beds: 4, list_price: 600000 }),
      _listing('huge', { property_type: 'single_family', sqft: 5000, beds: 8, list_price: 1500000 }),
    ])
    expect(res.relaxed).toBe('showing the nearest matches')
    expect(res.comps.length).toBe(2)
  })
  it('widened sqft rung labeled', () => {
    const res = comps.rank_comparables(_subject({ sqft: 2000 }), [
      _listing('widish', { property_type: 'single_family', beds: 4, sqft: 2700, list_price: 800000 }),
    ])
    expect(res.comps.map((c: any) => c.property_id)).toEqual(['widish'])
    expect(res.relaxed).toBe('widened the size range to ±40%')
  })
})

describe('filters', () => {
  const pool = () =>
    Array.from({ length: 6 }, (_, i) =>
      _listing(`c${i}`, {
        property_type: 'single_family', beds: 3 + (i % 2), baths: 2.0 + (i % 2),
        sqft: 1900 + i * 20, list_price: 500000 + i * 40000,
      }),
    )

  it('filters draw from whole pool before ranking', () => {
    const res = comps.rank_comparables(_subject(), pool(), { max_price: 560000 })
    const prices = res.comps.map((c: any) => c.list_price)
    expect(prices.length && prices.every((p: number) => p <= 560000)).toBe(true)
  })
  it('min_beds filter excludes below threshold', () => {
    const res = comps.rank_comparables(_subject(), pool(), { min_beds: 4 })
    expect(res.comps.length).toBeGreaterThan(0)
    expect(res.comps.every((c: any) => c.beds >= 4)).toBe(true)
  })
  it('candidate missing dimension not excluded by filter', () => {
    const res = comps.rank_comparables(
      _subject(),
      [_listing('nobeds', { property_type: 'single_family', sqft: 2000, list_price: 600000 })],
      { min_beds: 4 },
    )
    expect(res.comps.map((c: any) => c.property_id)).toEqual(['nobeds'])
  })
  it('null filters are noop', () => {
    const f = { min_price: null, max_price: null, min_beds: null, min_baths: null, min_sqft: null, max_sqft: null }
    const with_f = comps.rank_comparables(_subject(), pool(), f)
    const without = comps.rank_comparables(_subject(), pool())
    expect(with_f.comps.map((c: any) => c.property_id)).toEqual(without.comps.map((c: any) => c.property_id))
  })
})

describe('comp_domain', () => {
  it('domain spans full unfiltered pool', () => {
    const listings = Array.from({ length: 10 }, (_, i) =>
      _listing(`c${i}`, { property_type: 'single_family', beds: 4, sqft: 1900 + i * 20, list_price: 500000 + i * 30000 }),
    )
    const dom = comps.comp_domain(_subject(), listings)
    expect(dom.count).toBe(10)
    expect(Math.min(...dom.prices)).toBe(500000)
    expect(Math.max(...dom.prices)).toBe(770000)
    expect(dom.sqfts.length).toBe(10)
  })
  it('empty pool domain', () => {
    const dom = comps.comp_domain(_subject(), [])
    expect(dom).toEqual({ prices: [], sqfts: [], count: 0 })
  })
})

describe('subject data', () => {
  it('limited flag when subject lacks sqft', () => {
    const res = comps.rank_comparables(_subject({ sqft: null }), [
      _listing('c', { property_type: 'single_family', beds: 4, sqft: 2000, list_price: 600000 }),
    ])
    expect(res.limited).toBe(true)
    expect(res.subject_price_per_sqft).toBeNull()
    expect(res.comps.map((c: any) => c.property_id)).toEqual(['c'])
  })
  it('subject ppsf uses estimate when no list price', () => {
    const res = comps.rank_comparables(_subject({ list_price: null, best_current_estimate: 620000, sqft: 2000 }), [])
    expect(res.subject_price_per_sqft).toBe(310)
  })
})
