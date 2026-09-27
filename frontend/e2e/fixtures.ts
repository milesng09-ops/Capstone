/**
 * A workspace with candles in it, and no backend behind it.
 *
 * Every request to the API is answered here rather than by the real service.
 * Three reasons, and the third is the one that decides it:
 *
 * - The provider is quota'd at five requests a minute. A suite that spends
 *   that quota is a suite nobody runs twice.
 * - Live bars change, so any assertion about what is on screen would be
 *   describing today's market rather than the app.
 * - These tests are about *layout* -- whether a surface covers its pane,
 *   whether a menu fits on screen. That question has one right answer for a
 *   given set of candles, so the candles should be given rather than fetched.
 *
 * The bars are a fixed-seed random walk. They need to look like a market only
 * closely enough that the chart draws them and the detectors have something
 * to find.
 */

import type { Page, Route } from '@playwright/test'

const HOUR = 3_600_000
/** A Monday, so the session-anchored buckets land somewhere sensible. */
const START = 1_780_000_000_000 - (1_780_000_000_000 % HOUR)

export interface Bar {
  symbol: string
  time: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** Deterministic: the same seed gives the same chart on every run. */
function walk(symbol: string, count: number, base: number, seed: number): Bar[] {
  let state = seed
  const next = () => {
    // Mulberry32. Any small PRNG would do; this one is short and stable.
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }

  const bars: Bar[] = []
  let price = base
  for (let index = 0; index < count; index += 1) {
    const open = price
    const close = Math.max(1, open + (next() - 0.5) * base * 0.004)
    const high = Math.max(open, close) + next() * base * 0.001
    const low = Math.min(open, close) - next() * base * 0.001
    bars.push({
      symbol,
      time: START + index * HOUR,
      open,
      high,
      low,
      close,
      volume: Math.round(next() * 1000) + 100,
    })
    price = close
  }
  return bars
}

const BASE_PRICE: Record<string, number> = { ES: 5600, NQ: 20000, YM: 42000 }

export const BAR_COUNT = 400

/**
 * Answer every API call from memory.
 *
 * Registered with a single `**` pattern so a route this does not know about
 * fails loudly as a 500 with its own path in the body, rather than hanging
 * until the test times out and reports nothing useful.
 */
export async function stubApi(page: Page): Promise<void> {
  await page.route('**/api/**', async (route: Route) => {
    const url = new URL(route.request().url())
    const path = url.pathname
    const json = (body: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

    if (path === '/api/health') {
      return json({
        status: 'ok',
        provider: 'stub',
        fallback_active: false,
        database: 'connected',
        version: 'e2e',
        environment: 'test',
      })
    }

    if (path === '/api/providers/status') {
      return json({
        active_provider: 'stub',
        requested_provider: 'stub',
        fallback_active: false,
        fallback_reason: null,
        massive_api_key_configured: true,
        providers: [],
        fallback_history: [],
      })
    }

    if (path === '/api/symbols') {
      return json({
        symbols: ['ES', 'NQ', 'YM'].map((symbol) => ({
          symbol,
          display_name: `${symbol} stub`,
          exchange: 'CME',
          currency: 'USD',
          asset_type: 'future',
          timezone: 'America/Chicago',
          price_precision: symbol === 'YM' ? 0 : 2,
          tick_size: 0.25,
          contract_note: 'Stubbed for the browser tests.',
        })),
      })
    }

    if (path === '/api/bars') {
      const symbol = url.searchParams.get('symbol') ?? 'ES'
      const interval = url.searchParams.get('interval') ?? '1h'
      return json({
        symbol,
        interval,
        provider: 'stub',
        cached: true,
        fallback_active: false,
        fallback_reason: null,
        quality: 'cached',
        rate_limited: false,
        retry_after_seconds: null,
        bars: walk(symbol, BAR_COUNT, BASE_PRICE[symbol] ?? 1000, symbol.length * 7919),
      })
    }

    if (path === '/api/ict') {
      const symbol = url.searchParams.get('symbol') ?? 'ES'
      return json({
        symbol,
        interval: url.searchParams.get('interval') ?? '1h',
        from_time: START,
        to_time: START + BAR_COUNT * HOUR,
        provider: 'stub',
        bars_analysed: BAR_COUNT,
        swing_strength: 2,
        reference_symbols: [],
        swing_points: [],
        fair_value_gaps: [],
        smt_divergences: [],
        liquidity_pools: [],
        warnings: [],
      })
    }

    if (path === '/api/backtests') return json({ backtests: [] })
    if (path === '/api/intervals') return json({ intervals: [] })
    if (path === '/api/cache') {
      return json({ total_candles: 0, per_symbol: [], database_path: ':memory:', last_fetch_ms: null })
    }

    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ detail: `e2e stub has no handler for ${path}` }),
    })
  })
}

/**
 * Open the workspace with a known, empty starting state.
 *
 * The workspace persists to localStorage, so without this a run would inherit
 * whatever the last one drew -- and the drawing assertions count shapes.
 */
export async function openWorkspace(page: Page): Promise<void> {
  await stubApi(page)
  await page.addInitScript(() => window.localStorage.removeItem('mrl.workspace'))
  await page.goto('/')
  // The overlay only mounts once the chart is ready and has candles, so every
  // geometry assertion below would race the fetch without this.
  await page.locator('.chart-legend').first().waitFor({ state: 'visible' })
  await page.locator(OVERLAY).first().waitFor({ state: 'attached' })
}

/** The drawing surface: a direct child canvas of the pane, above the chart. */
export const OVERLAY = 'div.panel > canvas'

/** One pane per charted symbol, each holding a legend. */
export const PANE = 'div.panel:has(.chart-legend)'

export async function drawingCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('mrl.workspace')
    if (!raw) return 0
    return (JSON.parse(raw)?.state?.drawings ?? []).length
  })
}

export async function drawingKinds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem('mrl.workspace')
    if (!raw) return []
    return (JSON.parse(raw)?.state?.drawings ?? []).map((d: { kind: string }) => d.kind)
  })
}

/** Press a tool in the rail by its accessible name. */
export async function pickTool(page: Page, name: string): Promise<void> {
  await page.locator('nav button').filter({ has: page.locator(`[aria-label="${name}"]`) }).first()
    .or(page.getByRole('button', { name, exact: true }))
    .first()
    .click()
}
