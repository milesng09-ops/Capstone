import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  buildBacktestRequest,
  RUN_BACKTEST_MUTATION_KEY,
  searchedSymbols,
  useRunBacktest,
} from '@/hooks/useBacktest'
import { buildRange } from '@/hooks/useChartRange'
import { ApiError, api } from '@/services/api'
import { useWorkspace } from '@/store/workspace'
import {
  DEFAULT_DETECTOR_FILTERS,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_TRADE_RULES,
  type BacktestRequest,
  type BacktestResult,
} from '@/types/backtest'
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

  it('holds the lookback to what a chart of the interval can load', () => {
    // 180 days of 1-minute bars was read slice by slice against the quota,
    // for a chart that holds seven -- trades it could never show.
    const minute = build({ selection: { ...selection, source_interval: '1m' } })
    expect(minute.search.lookback_start).toBe(1_790_000_000_000 - 7 * DAY_MS)

    const hourly = build()
    expect(hourly.search.lookback_start).toBe(
      1_790_000_000_000 - DEFAULT_SEARCH_CONFIG.lookbackDays * DAY_MS,
    )
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
  it('snaps the end to the hour so the query key is stable', () => {
    const now = 1_790_000_123_456
    const first = buildRange(30, now)
    const second = buildRange(30, now + 60_000)
    expect(first).toEqual(second)
  })

  it('starts a new window once the hour rolls over', () => {
    const now = 1_790_000_123_456
    const later = buildRange(30, now + 3_600_000)
    expect(later.to).toBeGreaterThan(buildRange(30, now).to)
  })

  it('spans the requested number of days', () => {
    const range = buildRange(90, 1_790_000_000_000)
    expect(range.to - range.from).toBe(90 * DAY_MS)
  })

  it('ends on an hour boundary, whatever minute it is asked at', () => {
    // The property the shared window rests on: every interval computes the
    // same range from the same clock, so switching timeframe asks for a
    // window the cache already holds.
    for (let minute = 0; minute < 60; minute += 7) {
      const { to } = buildRange(30, Date.UTC(2026, 8, 4, 7, minute, 30))
      expect(to).toBe(Date.UTC(2026, 8, 4, 8))
    }
  })

  it('does not snap the end to the old 02:00 UTC anchor', () => {
    // What replaced the interval-specific snapping. 4h bars are anchored to
    // the exchange session now, and the backend owns that; the client window
    // is deliberately interval-agnostic.
    const to = buildRange(30, Date.UTC(2026, 8, 4, 7, 30)).to
    expect(new Date(to).getUTCHours()).toBe(8)
  })

  it('keeps the bar currently forming inside the window', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const now = Date.UTC(2026, 8, 4, hour, 15)
      const { to } = buildRange(30, now)
      expect(to).toBeGreaterThan(now)
    }
  })
})

describe('the higher timeframe a bias is read from', () => {
  it('is left out entirely when no bias was asked for', () => {
    /*
     * The backend refuses a higher timeframe that is not strictly coarser
     * than the entry one. A stored 4h setting left over from an hourly
     * workspace would otherwise fail a daily run that never wanted a bias.
     */
    const request = build({ interval: '1d', higherTimeframe: '4h' })

    expect(request.higher_timeframe).toBeNull()
  })

  it('is sent when the bias condition is on', () => {
    const request = build({
      detectors: { ...DEFAULT_DETECTOR_FILTERS, require_higher_timeframe_bias: true },
      higherTimeframe: '4h',
    })

    expect(request.higher_timeframe).toBe('4h')
  })

  it('selects a valid default when the condition is on but nothing was chosen', () => {
    const request = build({
      detectors: { ...DEFAULT_DETECTOR_FILTERS, require_higher_timeframe_bias: true },
    })

    expect(request.higher_timeframe).toBe('4h')
  })
})

describe('the bar size a run is made at', () => {
  // Drawn on a primary pane of its own 5m while the toolbar said 1h.
  const fiveMinuteSetup: SelectionRange = { ...selection, source_interval: '5m' }

  it('is the one the setup was drawn on, not the toolbar interval', () => {
    // Sent at 1h, the 49 five-minute bars of a setup were tested as five
    // hourly ones.
    const request = build({ selection: fiveMinuteSetup, interval: '1h' })

    expect(request.interval).toBe('5m')
  })

  it('reads the bias against that bar size too', () => {
    // 15m is made of whole 5m bars; against 1h it was "corrected" to 4h.
    const request = build({
      selection: fiveMinuteSetup,
      interval: '1h',
      detectors: { ...DEFAULT_DETECTOR_FILTERS, require_higher_timeframe_bias: true },
      higherTimeframe: '15m',
    })

    expect(request.higher_timeframe).toBe('15m')
  })
})

describe('an SMT condition with one market named', () => {
  const smt = { ...DEFAULT_DETECTOR_FILTERS, require_smt_divergence: true }
  const nqOnly = { ...DEFAULT_SEARCH_CONFIG, searchSymbols: ['NQ'] }

  it('loads a charted partner to compare against, without trading it', () => {
    // "Long NQ after an SMT divergence" narrowed the run to NQ, and every
    // match was then dropped as "no confirmed SMT divergence". Searching the
    // partner fixed that by trading ES too; it is loaded, not searched.
    const request = build({ search: nqOnly, detectors: smt })

    expect(request.symbols).toEqual(['NQ', 'ES'])
    expect(request.search.search_symbols).toEqual(['NQ'])
  })

  it('says which market it added, so the panel can too', () => {
    const searched = searchedSymbols({
      primarySymbol: 'NQ',
      symbols: ['NQ', 'ES'],
      search: nqOnly,
      detectors: smt,
    })

    expect(searched).toEqual({ symbols: ['NQ', 'ES'], addedForSmt: ['ES'] })
  })

  it('adds nothing when no divergence is asked for', () => {
    expect(build({ search: nqOnly }).symbols).toEqual(['NQ'])
  })

  it('adds nothing when two markets are already searched', () => {
    const request = build({
      search: { ...DEFAULT_SEARCH_CONFIG, searchSymbols: ['NQ', 'YM'] },
      detectors: smt,
    })

    expect(request.symbols).toEqual(['NQ', 'YM'])
  })

  it('has nothing to add when no other market is charted', () => {
    const request = build({ symbols: ['NQ'], search: nqOnly, detectors: smt })

    expect(request.symbols).toEqual(['NQ'])
  })
})

describe('running a backtest', () => {
  const RESULT = { id: 'run-7', trades: [], matches: [] } as unknown as BacktestResult

  function wrapper() {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    const Wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children)
    return { client, Wrapper }
  }

  /**
   * A request that resolves or rejects only when the test says so. Waits for
   * the request to have been sent, which the mutation does a tick after
   * `mutate`, so a test can unmount while it is genuinely in flight.
   */
  function deferred() {
    let settle: { resolve: (value: BacktestResult) => void; reject: (error: Error) => void }
    const sent = vi.spyOn(api, 'createBacktest').mockImplementation(
      () =>
        new Promise<BacktestResult>((resolve, reject) => {
          settle = { resolve, reject }
        }),
    )
    return async () => {
      await waitFor(() => expect(sent).toHaveBeenCalled())
      return settle
    }
  }

  beforeEach(() => {
    useWorkspace.setState({ activeBacktestId: null, runError: null })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('opens a run that finishes after the panel that started it has gone', async () => {
    // Focus mode, the Analysis tab and collapsing the column all unmount the
    // Strategy panel, and options passed to `mutate` die with it.
    const settle = deferred()
    const { Wrapper } = wrapper()
    const { result, unmount } = renderHook(() => useRunBacktest(), { wrapper: Wrapper })

    act(() => {
      result.current.mutate({} as BacktestRequest, {
        onSuccess: (run) => useWorkspace.getState().setActiveBacktestId(run.id),
      })
    })
    const request = await settle()
    unmount()
    await act(async () => request.resolve(RESULT))

    await waitFor(() => expect(useWorkspace.getState().activeBacktestId).toBe('run-7'))
  })

  it('keeps the reason a run failed after the panel has gone', async () => {
    const settle = deferred()
    const { Wrapper } = wrapper()
    const { result, unmount } = renderHook(() => useRunBacktest(), { wrapper: Wrapper })

    act(() => result.current.mutate({} as BacktestRequest))
    const request = await settle()
    unmount()
    await act(async () =>
      request.reject(new ApiError('A backtest is already running for this session.', 409)),
    )

    await waitFor(() =>
      expect(useWorkspace.getState().runError).toBe(
        'A backtest is already running for this session.',
      ),
    )
  })

  it('clears an old failure when the next run starts', async () => {
    deferred()
    useWorkspace.setState({ runError: 'an earlier failure' })
    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useRunBacktest(), { wrapper: Wrapper })

    act(() => result.current.mutate({} as BacktestRequest))

    await waitFor(() => expect(useWorkspace.getState().runError).toBeNull())
  })

  it('runs under a key any component can watch while it is in flight', async () => {
    deferred()
    const { client, Wrapper } = wrapper()
    const { result } = renderHook(() => useRunBacktest(), { wrapper: Wrapper })

    act(() => result.current.mutate({} as BacktestRequest))

    await waitFor(() =>
      expect(client.isMutating({ mutationKey: RUN_BACKTEST_MUTATION_KEY })).toBe(1),
    )
    const [run] = client.getMutationCache().getAll()
    expect(run.options.mutationKey).toEqual(['run-backtest'])
  })
})
