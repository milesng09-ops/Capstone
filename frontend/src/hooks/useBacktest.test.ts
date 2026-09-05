import { describe, expect, it } from 'vitest'

import { buildBacktestRequest } from '@/hooks/useBacktest'
import { buildRange } from '@/hooks/useChartRange'
import { DEFAULT_SEARCH_CONFIG, DEFAULT_TRADE_RULES } from '@/types/backtest'
import type { SelectionRange } from '@/types/market'

const DAY_MS = 86_400_000

const selection: SelectionRange = {
  symbol: 'NQ',
  start_time: 1_780_000_000_000,
  end_time: 1_780_043_200_000,
  source_interval: '1h',
}

function build(overrides: Partial<Parameters<typeof buildBacktestRequest>[0]> = {}) {
  return buildBacktestRequest({
    selection,
    primarySymbol: 'NQ',
    symbols: ['NQ', 'ES'],
    interval: '1h',
    rules: DEFAULT_TRADE_RULES,
    search: DEFAULT_SEARCH_CONFIG,
    rangeEnd: 1_790_000_000_000,
    ...overrides,
  })
}

describe('buildBacktestRequest', () => {
  it('carries the selection through unchanged', () => {
    const request = build()
    expect(request.selection).toEqual({
      start_time: selection.start_time,
      end_time: selection.end_time,
    })
  })

  it('derives the lookback window from the loaded range', () => {
    const request = build()
    expect(request.search.lookback_end).toBe(1_790_000_000_000)
    expect(request.search.lookback_start).toBe(
      1_790_000_000_000 - DEFAULT_SEARCH_CONFIG.lookbackDays * DAY_MS,
    )
  })

  it('searches exactly the drawn window when there is one', () => {
    // Miles asked for "from when to when", not "how many days back": a window
    // dragged on the chart has to be the range that is tested, unchanged.
    const request = build({
      testWindow: { start_time: 1_781_000_000_000, end_time: 1_785_000_000_000 },
    })
    expect(request.search.lookback_start).toBe(1_781_000_000_000)
    expect(request.search.lookback_end).toBe(1_785_000_000_000)
  })

  it('orders a window that was dragged right to left', () => {
    const request = build({
      testWindow: { start_time: 1_785_000_000_000, end_time: 1_781_000_000_000 },
    })
    expect(request.search.lookback_start).toBeLessThan(request.search.lookback_end)
  })

  it('leaves the selected setup alone when a window is drawn', () => {
    // The window says where to look, not what to look for.
    const request = build({
      testWindow: { start_time: 1_781_000_000_000, end_time: 1_785_000_000_000 },
    })
    expect(request.selection).toEqual({
      start_time: selection.start_time,
      end_time: selection.end_time,
    })
  })

  it('always includes the primary symbol, without duplicating it', () => {
    const request = build({
      primarySymbol: 'YM',
      search: { ...DEFAULT_SEARCH_CONFIG, searchSymbols: ['ES', 'YM'] },
    })
    expect(request.primary_symbol).toBe('YM')
    expect(request.symbols).toEqual(['YM', 'ES'])
    expect(request.search.search_symbols).toEqual(['YM', 'ES'])
  })

  it('falls back to the charted symbols when no search symbols are set', () => {
    const request = build({ search: { ...DEFAULT_SEARCH_CONFIG, searchSymbols: [] } })
    expect(request.symbols).toEqual(['NQ', 'ES'])
  })

  it('defaults to a similarity threshold that actually returns matches', () => {
    // 0.75 returns nothing at all against real index-futures history; a first
    // run that always comes back empty reads as a broken app.
    expect(build().search.minimum_similarity).toBeLessThanOrEqual(0.6)
  })
})

describe('buildRange', () => {
  it('snaps the end to the interval bucket so the query key is stable', () => {
    const now = 1_790_000_123_456
    const first = buildRange('1h', 30, now)
    const second = buildRange('1h', 30, now + 60_000)
    expect(first).toEqual(second)
  })

  it('starts a new window once the bucket rolls over', () => {
    const now = 1_790_000_123_456
    const later = buildRange('1h', 30, now + 3_600_000)
    expect(later.to).toBeGreaterThan(buildRange('1h', 30, now).to)
  })

  it('spans the requested number of days', () => {
    const range = buildRange('1d', 90, 1_790_000_000_000)
    expect(range.to - range.from).toBe(90 * DAY_MS)
  })

  it('snaps 4h to the 02:00 UTC anchor, not to a plain multiple', () => {
    // 4h bars open at 02:00/06:00/... UTC, so the end of the window has to
    // land on one of those and never on 00:00/04:00.
    const now = Date.UTC(2026, 8, 4, 7, 30)
    const to = buildRange('4h', 30, now).to
    expect(new Date(to).toISOString()).toBe('2026-09-04T10:00:00.000Z')
  })

  it('keeps the forming 4h bar inside the window', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const now = Date.UTC(2026, 8, 4, hour, 15)
      const { to } = buildRange('4h', 30, now)
      expect(to).toBeGreaterThan(now)
      expect(new Date(to).getUTCHours() % 4).toBe(2)
    }
  })
})
