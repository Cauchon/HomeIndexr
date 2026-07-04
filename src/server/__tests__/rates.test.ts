// Ported from backend/test_rates.py. DB-backed cache + mocked FRED HTTP.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as rates from '../rates'
import * as store from '../store'
import { fresh_db } from './helpers'

function fakeResp(payload: any): any {
  return {
    ok: true,
    status: 200,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  }
}

function _obs(...pairs: [string, string][]): any {
  return { observations: pairs.map(([date, value]) => ({ date, value })) }
}

function reset(): void {
  delete process.env.FRED_API_KEY
  delete process.env.FRED_API_BASE
  fresh_db()
}

describe('rates', () => {
  beforeEach(() => {
    reset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env.FRED_API_KEY
  })

  it('unavailable without key', async () => {
    const out = await rates.get_mortgage_rates()
    expect(out.available).toBe(false)
    expect(out.key_present).toBe(false)
    expect(out.rate_30).toBeNull()
    expect(out.rate_15).toBeNull()
  })

  it('fetch parses latest non-missing and caches', async () => {
    process.env.FRED_API_KEY = 'test-key'
    const series: Record<string, any> = {
      MORTGAGE30US: _obs(['2026-05-29', '.'], ['2026-05-22', '6.52']),
      MORTGAGE15US: _obs(['2026-05-29', '5.74']),
    }
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: any) => {
      const url = new URL(String(input))
      const sid = url.searchParams.get('series_id') as string
      return fakeResp(series[sid])
    })

    const out = await rates.get_mortgage_rates()
    expect(out.available).toBe(true)
    expect(out.rate_30).toBe(6.52)
    expect(out.rate_15).toBe(5.74)
    expect(out.observation_date).toBe('2026-05-29')
    expect(spy).toHaveBeenCalledTimes(2)

    // Second call inside the TTL is served from cache — no new fetch.
    const again = await rates.get_mortgage_rates()
    expect(again.rate_30).toBe(6.52)
    expect(spy).toHaveBeenCalledTimes(2)

    const cached = store.get_cached_mortgage_rates()
    expect(cached.rate_30).toBe(6.52)
  })

  it('fetch failure serves stale cache', async () => {
    process.env.FRED_API_KEY = 'test-key'
    store.save_mortgage_rates_cache({
      source: rates.SOURCE ?? 'Freddie Mac PMMS via FRED',
      rate_30: 6.4,
      rate_15: 5.6,
      observation_date: '2026-05-15',
      fetched_at: 1,
    })
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const out = await rates.get_mortgage_rates()
    expect(out.available).toBe(true)
    expect(out.stale).toBe(true)
    expect(out.rate_30).toBe(6.4)
  })

  it('fetch failure without cache is unavailable', async () => {
    process.env.FRED_API_KEY = 'test-key'
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    const out = await rates.get_mortgage_rates()
    expect(out.available).toBe(false)
    expect(out.error).toBe('fetch failed')
  })
})
