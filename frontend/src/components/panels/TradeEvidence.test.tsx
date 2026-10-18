/**
 * "Why the engine took this trade", and when it may say "nothing".
 *
 * The step that lists the detections used to be read off the chart's own
 * analysis: the interval on screen, the history currently loaded, and the
 * Analysis panel's settings. So it explained a 1h trade with 15m detections
 * once the chart moved to 15m, and -- because a failed request, or a trade
 * older than the loaded history, both leave nothing to list -- it told the
 * user "Nothing was detected over these bars" when nothing had been looked at.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TradeEvidence } from '@/components/panels/TradeEvidence'
import { api } from '@/services/api'
import { useWorkspace } from '@/store/workspace'
import {
  DEFAULT_DETECTOR_FILTERS,
  DEFAULT_TRADE_RULES,
  type BacktestResult,
  type Trade,
} from '@/types/backtest'
import { DEFAULT_ICT_SETTINGS, type IctAnalysis } from '@/types/ict'
import { DEFAULT_CHART_SYNC } from '@/types/market'

const DAY = 86_400_000
const HOUR = 3_600_000
/** A year before the chart's window ends, far outside 30 days of history. */
const ENTRY = Math.floor(Date.now() / HOUR) * HOUR - 365 * DAY

const TRADE = {
  id: 'trade-1',
  trade_number: 1,
  symbol: 'NQ',
  direction: 'long',
  entry_time: ENTRY,
  exit_time: ENTRY + 6 * HOUR,
  entry_price: 100,
  exit_price: 102,
  stop_price: 99,
  target_price: 102,
  net_return: 1.9,
  exit_reason: 'take_profit',
  holding_bars: 6,
  same_bar_ambiguity: false,
  similarity_score: 0.91,
  pattern_match_id: null,
} as unknown as Trade

function run(overrides: Partial<BacktestResult> = {}): BacktestResult {
  return {
    id: 'run-1',
    created_at: ENTRY + 400 * DAY,
    status: 'complete',
    primary_symbol: 'NQ',
    symbols: ['NQ', 'ES'],
    interval: '1h',
    selection: { start_time: 1, end_time: 2 },
    provider: 'cached',
    error_message: null,
    configuration: {
      symbols: ['NQ', 'ES'],
      primary_symbol: 'NQ',
      interval: '1h',
      higher_timeframe: null,
      selection: { start_time: 1, end_time: 2 },
      trade: DEFAULT_TRADE_RULES,
      search: {
        lookback_start: ENTRY - 30 * DAY,
        lookback_end: ENTRY + 300 * DAY,
        pattern_length: null,
        maximum_matches: 25,
        minimum_similarity: 0.75,
        minimum_separation_bars: null,
        search_symbols: ['NQ', 'ES'],
      },
      detectors: {
        ...DEFAULT_DETECTOR_FILTERS,
        swing_strength: 3,
        liquidity_tolerance_percent: 0.05,
        liquidity_min_touches: 3,
        require_smt_divergence: true,
      },
      learning: {
        enabled: false,
        train_fraction: 0.5,
        query_samples: 60,
        grouped: false,
        objective: 'expectancy',
      },
    } as BacktestResult['configuration'],
    summary: null,
    matches: [],
    trades: [TRADE],
    ...overrides,
  }
}

function analysis(overrides: Partial<IctAnalysis> = {}): IctAnalysis {
  return {
    symbol: 'NQ',
    interval: '1h',
    from_time: 0,
    to_time: 0,
    provider: 'cached',
    bars_analysed: 500,
    swing_strength: 3,
    reference_symbols: ['ES'],
    swing_points: [],
    fair_value_gaps: [],
    smt_divergences: [],
    liquidity_pools: [],
    warnings: [],
    ...overrides,
  }
}

function renderEvidence(result: BacktestResult | null = run()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  if (result) client.setQueryData(['backtest', result.id], result)
  return render(
    <QueryClientProvider client={client}>
      <TradeEvidence trade={TRADE} match={null} rules={DEFAULT_TRADE_RULES} />
    </QueryClientProvider>,
  )
}

/** The text of step 2, once it has stopped loading. */
async function detectorStep() {
  await waitFor(() => expect(screen.queryByText(/Loading the analysis/)).toBeNull())
  return screen.getByText(/Detectors standing here/).parentElement?.textContent ?? ''
}

beforeEach(() => {
  useWorkspace.setState({
    primarySymbol: 'NQ',
    compareSymbols: ['ES'],
    // The chart has moved on since the run: a finer interval, less history.
    interval: '15m',
    rangeDays: 30,
    chartSync: DEFAULT_CHART_SYNC,
    intervalOverrides: {},
    ict: { ...DEFAULT_ICT_SETTINGS, swingStrength: 5 },
    activeBacktestId: 'run-1',
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('what the evidence is read from', () => {
  it('asks for the run’s own interval and detector settings, not the chart’s', async () => {
    const ict = vi.spyOn(api, 'ict').mockResolvedValue(analysis())
    renderEvidence()
    await waitFor(() => expect(ict).toHaveBeenCalled())

    const params = ict.mock.calls.at(-1)![0]
    expect(params.symbol).toBe('NQ')
    expect(params.interval).toBe('1h')
    expect(params.swingStrength).toBe(3)
    expect(params.liquidityTolerancePercent).toBe(0.05)
    expect(params.liquidityMinTouches).toBe(3)
    // As the engine built them: gaps of any size, filled ones kept.
    expect(params.minGapPercent).toBe(0)
    expect(params.includeFilledGaps).toBe(true)
    expect(params.reference).toEqual(['ES'])
  })

  it('asks for history that covers the trade, wherever the chart is', async () => {
    const ict = vi.spyOn(api, 'ict').mockResolvedValue(analysis())
    renderEvidence()
    await waitFor(() => expect(ict).toHaveBeenCalled())

    const { from, to } = ict.mock.calls.at(-1)![0]
    expect(from).toBeLessThanOrEqual(TRADE.entry_time)
    expect(to).toBeGreaterThanOrEqual(TRADE.exit_time)
  })

  it('falls back to the chart’s settings for a run saved without its own', async () => {
    const ict = vi.spyOn(api, 'ict').mockResolvedValue(analysis())
    renderEvidence(run({ configuration: {} as BacktestResult['configuration'] }))
    await waitFor(() => expect(ict).toHaveBeenCalled())

    const { interval, swingStrength, from, to } = ict.mock.calls.at(-1)![0]
    expect(interval).toBe('1h')
    expect(swingStrength).toBe(5)
    expect(from).toBeLessThanOrEqual(TRADE.entry_time)
    expect(to).toBeGreaterThanOrEqual(TRADE.exit_time)
  })

  it('reads the trade’s own pane when the run itself is not to hand', async () => {
    vi.spyOn(api, 'getBacktest').mockReturnValue(new Promise(() => {}))
    const ict = vi.spyOn(api, 'ict').mockResolvedValue(analysis())
    renderEvidence(null)
    await waitFor(() => expect(ict).toHaveBeenCalled())

    const { interval, from, to } = ict.mock.calls.at(-1)![0]
    expect(interval).toBe('15m')
    expect(from).toBeLessThanOrEqual(TRADE.entry_time)
    expect(to).toBeGreaterThanOrEqual(TRADE.exit_time)
  })

  it('says which timeframe it read when the chart is on another', async () => {
    vi.spyOn(api, 'ict').mockResolvedValue(analysis())
    renderEvidence()

    expect(await detectorStep()).toMatch(/Read on the 1H bars the run was tested on/)
  })
})

describe('what it says when there is nothing to list', () => {
  it('says the analysis failed, rather than that nothing was there', async () => {
    vi.spyOn(api, 'ict').mockRejectedValue(new Error('The configuration could not be used.'))
    renderEvidence()

    const text = await detectorStep()
    expect(text).toMatch(/could not be loaded/)
    expect(text).not.toMatch(/Nothing was detected/)
  })

  it('says no candles were there to analyse, rather than that nothing was found', async () => {
    vi.spyOn(api, 'ict').mockResolvedValue(analysis({ bars_analysed: 0 }))
    renderEvidence()

    const text = await detectorStep()
    expect(text).toMatch(/no candles/i)
    expect(text).not.toMatch(/Nothing was detected/)
  })

  it('says "nothing was detected" only once the bars were actually analysed', async () => {
    vi.spyOn(api, 'ict').mockResolvedValue(analysis())
    renderEvidence()

    expect(await detectorStep()).toMatch(/Nothing was detected over these bars/)
  })
})

describe('a trade early in a long run', () => {
  it('ends the request at this trade, so its detections are among the newest kept', async () => {
    // The endpoint returns only the most recent few hundred of each kind. A
    // request running to the end of a 300-day run kept the latest ones and
    // dropped this trade's.
    const ict = vi.spyOn(api, 'ict').mockResolvedValue(analysis())
    renderEvidence()
    await waitFor(() => expect(ict).toHaveBeenCalled())

    const { to } = ict.mock.calls.at(-1)![0]
    expect(to).toBeLessThanOrEqual(TRADE.exit_time + 2 * HOUR)
  })

  it('does not call a trimmed analysis a finding of nothing', async () => {
    vi.spyOn(api, 'ict').mockResolvedValue(
      analysis({ warnings: ['Showing the 600 most recent swing points of 2,400.'] }),
    )
    renderEvidence()

    const step = await detectorStep()
    expect(step).toMatch(/trimmed to its most recent detections/)
    expect(step).not.toMatch(/Nothing was detected/)
  })
})
