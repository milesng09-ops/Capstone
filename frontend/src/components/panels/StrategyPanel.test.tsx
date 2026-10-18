/**
 * Conditional rendering inside the strategy panel: fields that only make
 * sense once their condition is switched on, and the higher-timeframe list
 * that must never offer a pairing the backend would refuse.
 *
 * The bias timeframe list matters most. The backend rejects a run whose
 * higher timeframe is not strictly coarser than the entry interval, so an
 * option this panel should never have shown in the first place is not a
 * cosmetic slip -- it is a run that fails only once the button is pressed,
 * with nothing on screen beforehand to explain why. The session order
 * matters for a quieter reason: a summary that reads differently depending
 * on the order two killzones were clicked looks like a second bug sitting on
 * top of whichever one produced it.
 *
 * The folded summaries are read the way a trader actually reads them --
 * through the collapsed header -- rather than asserted against the state
 * object directly, since biasSummary, entrySummary and sessionSummary are
 * not exported. A summary that drifts from the state behind it is wrong in a
 * way nobody notices until the run it described turns out to be a different
 * one.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { StrategyPanel } from '@/components/panels/StrategyPanel'
import { api } from '@/services/api'
import { useWorkspace } from '@/store/workspace'
import {
  DEFAULT_DETECTOR_FILTERS,
  DEFAULT_LEARNING_SETTINGS,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_TRADE_RULES,
  SESSION_KEYS,
  SESSION_LABELS,
} from '@/types/backtest'
import { DEFAULT_CHART_SYNC, type Candle } from '@/types/market'

// Real bars would mean a real fetch to a backend that is not running here.
// The panel only ever reads `.data?.bars` off the result, so a bare mock is
// enough to keep it off the network without pretending to be react-query.
const useBars = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useMarketData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useMarketData')>()),
  useBars,
}))

// `useRunBacktest` is left real -- it is inert until `.mutate()` is called,
// which none of these tests do -- but it still calls `useQueryClient()`
// internally, so a provider has to be in the tree or the render throws.
function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<StrategyPanel />, { wrapper: Wrapper })
}

/** Opens a folded section by clicking its header. */
function openDisclosure(name: RegExp) {
  fireEvent.click(screen.getByRole('button', { name }))
}

beforeEach(() => {
  useBars.mockReturnValue({ data: undefined, isLoading: false, isError: false })
  useWorkspace.setState({
    interval: '1h',
    higherTimeframe: '4h',
    selection: null,
    detectors: DEFAULT_DETECTOR_FILTERS,
  })
})

describe('the higher timeframe section', () => {
  it('keeps the "Read it from" selector hidden until the bias condition is switched on', () => {
    renderPanel()
    openDisclosure(/^Higher timeframe/)

    expect(screen.queryByLabelText('Read it from')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Trade with the higher timeframe' }))

    expect(screen.getByLabelText('Read it from')).toBeInTheDocument()
  })

  it('only offers timeframes coarser than the one being entered on', () => {
    // On 1h the backend accepts whole-bar aggregation from 4h upward.
    // is a bias timeframe that is not strictly coarser than the entry one,
    // and a run configured that way is refused only after the button is
    // pressed -- this list is what keeps that pairing off the form.
    useWorkspace.setState({
      detectors: { ...DEFAULT_DETECTOR_FILTERS, require_higher_timeframe_bias: true },
    })
    renderPanel()
    openDisclosure(/^Higher timeframe/)

    const select = screen.getByLabelText('Read it from') as HTMLSelectElement
    const offered = Array.from(select.options).map((option) => option.value)

    expect(offered).toEqual(['4h', '6h', '1d', '1w', '1mo'])
  })

  it('disables the bias toggle on the coarsest interval and explains why', () => {
    useWorkspace.setState({ interval: '1mo' })
    renderPanel()
    openDisclosure(/^Higher timeframe/)

    expect(
      screen.getByRole('switch', { name: 'Trade with the higher timeframe' }),
    ).toHaveProperty('disabled', true)
    expect(screen.getByText(/is the coarsest timeframe there is/)).toBeInTheDocument()
  })

  it('shows that explanation as a warning, in a class that exists', () => {
    // `text-warn` is not a token in the Tailwind config, so no CSS was ever
    // generated for it and the warning rendered as ordinary body text.
    useWorkspace.setState({ interval: '1mo' })
    renderPanel()
    openDisclosure(/^Higher timeframe/)

    const warning = screen.getByText(/is the coarsest timeframe there is/)
    expect(warning.className).not.toMatch(/\btext-warn\b/)
    expect(warning.className).toContain('text-amber-400')
  })
})

describe('the entry section', () => {
  it('keeps the reaction fields hidden until a reaction is required', () => {
    renderPanel()
    openDisclosure(/^Entry/)

    expect(screen.queryByLabelText('Wick at least')).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/^Came back/)).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('switch', { name: 'Needs a reaction' }))

    expect(screen.getByLabelText('Wick at least')).toBeInTheDocument()
    // Regex rather than an exact string: the field's "%" suffix is inside
    // the same <label>, so it is folded into the accessible name too.
    expect(screen.getByLabelText(/^Came back/)).toBeInTheDocument()
  })

  it('keeps the fib band hidden unless the entry model is a fib retracement', () => {
    renderPanel()
    openDisclosure(/^Entry/)

    expect(screen.queryByLabelText('From')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('To')).not.toBeInTheDocument()

    // 'immediate' is a real, distinct entry model rather than the absence of
    // one -- the band has to stay hidden for it too, or an immediate entry
    // would show inputs describing a retracement it never waits for.
    fireEvent.change(screen.getByLabelText('Entry off the level'), {
      target: { value: 'immediate' },
    })
    expect(screen.queryByLabelText('From')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Entry off the level'), {
      target: { value: 'fib_retrace' },
    })
    expect(screen.getByLabelText('From')).toBeInTheDocument()
    expect(screen.getByLabelText('To')).toBeInTheDocument()
  })
})

describe('the sessions section', () => {
  it('renders all four killzones with their labels', () => {
    renderPanel()
    openDisclosure(/^Sessions/)

    for (const key of SESSION_KEYS) {
      expect(screen.getByRole('switch', { name: SESSION_LABELS[key] })).toBeInTheDocument()
    }
  })

  it('keeps the session list in canonical order regardless of the order they were clicked', () => {
    renderPanel()
    openDisclosure(/^Sessions/)

    // Clicked in the reverse of SESSION_KEYS order, so a list that simply
    // appended whatever was pressed would read 'new_york_pm, london' instead.
    fireEvent.click(screen.getByRole('switch', { name: SESSION_LABELS.new_york_pm }))
    fireEvent.click(screen.getByRole('switch', { name: SESSION_LABELS.london }))

    expect(useWorkspace.getState().detectors.sessions).toEqual(['london', 'new_york_pm'])
  })
})

describe('the folded section summaries', () => {
  it('reads "any direction" as the bias summary when nothing is required', () => {
    renderPanel()
    expect(screen.getByText('any direction')).toBeInTheDocument()
  })

  it('reads "anywhere on the level" as the entry summary when no entry condition is set', () => {
    renderPanel()
    expect(screen.getByText('anywhere on the level')).toBeInTheDocument()
  })

  it('reads "any hour" as the session summary when no killzone is selected', () => {
    renderPanel()
    expect(screen.getByText('any hour')).toBeInTheDocument()
  })

  it('names the higher timeframe once a bias is required', () => {
    useWorkspace.setState({
      detectors: { ...DEFAULT_DETECTOR_FILTERS, require_higher_timeframe_bias: true },
      higherTimeframe: '4h',
    })
    renderPanel()

    expect(screen.getByText('with the 4H')).toBeInTheDocument()
  })

  it('names the entry model and the reaction once they are asked for', () => {
    useWorkspace.setState({
      detectors: {
        ...DEFAULT_DETECTOR_FILTERS,
        entry_model: 'fib_retrace',
        require_reaction: true,
      },
    })
    renderPanel()

    expect(screen.getByText('0.62-0.79 retrace, 50% wick')).toBeInTheDocument()
  })

  it('lists the sessions chosen, in canonical order, once some are set', () => {
    useWorkspace.setState({
      detectors: { ...DEFAULT_DETECTOR_FILTERS, sessions: ['london', 'new_york_pm'] },
    })
    renderPanel()

    expect(screen.getByText('London, New York PM')).toBeInTheDocument()
  })

  it('says "every session" once all four killzones are required', () => {
    useWorkspace.setState({
      detectors: { ...DEFAULT_DETECTOR_FILTERS, sessions: [...SESSION_KEYS] },
    })
    renderPanel()

    expect(screen.getByText('every session')).toBeInTheDocument()
  })
})

/*
 * With the interval link off the primary pane has a bar size of its own, and
 * the setup is dragged across *those* bars. The panel read the shared interval
 * instead: it looked the 5m timestamps up among 1h candles, found none, and sat
 * on "aligning..." with the run disabled -- or, when both ends happened to fall
 * on the hour, priced the setup from 1h bars and sent a 1h backtest of a
 * pattern drawn on 5m.
 */
describe('a setup drawn with the interval link off', () => {
  const H = 3_600_000
  const M5 = 300_000
  const base = 1_780_000_000_000 - (1_780_000_000_000 % H)
  const bars = (step: number, count: number): Candle[] =>
    Array.from({ length: count }, (_, index) => ({
      symbol: 'NQ',
      time: base + index * step,
      open: 1,
      high: 2,
      low: 0.5,
      close: 1.5,
      volume: 1,
    }))

  beforeEach(() => {
    useBars.mockImplementation((_symbol: string, interval: string) => ({
      data: { bars: interval === '5m' ? bars(M5, 600) : bars(H, 60) },
      isLoading: false,
      isError: false,
    }))
    useWorkspace.setState({
      primarySymbol: 'NQ',
      chartSync: { ...DEFAULT_CHART_SYNC, interval: false },
      intervalOverrides: { NQ: '5m' },
      // Dragged across nineteen 5m candles on the NQ pane, 10:05 to 11:35.
      selection: {
        symbol: 'NQ',
        start_time: base + 10 * H + M5,
        end_time: base + 11 * H + 7 * M5,
        source_interval: '5m',
      },
    })
  })

  afterEach(() => {
    useWorkspace.setState({ chartSync: DEFAULT_CHART_SYNC, intervalOverrides: {} })
  })

  it('prices it from the bars it was drawn on', () => {
    renderPanel()

    expect(screen.getByText('19 candles')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Test strategy/ })).not.toBeDisabled()
  })

  it('asks for those bars over the range that pane can load', () => {
    renderPanel()

    const [symbol, interval, from, to] = useBars.mock.calls.at(-1)!
    expect([symbol, interval]).toEqual(['NQ', '5m'])
    expect(to - from).toBeLessThanOrEqual(90 * 24 * H)
  })

  it('runs the backtest on that interval', async () => {
    const create = vi.spyOn(api, 'createBacktest').mockReturnValue(new Promise(() => {}))
    try {
      renderPanel()
      fireEvent.click(screen.getByRole('button', { name: /Test strategy/ }))

      await waitFor(() => expect(create).toHaveBeenCalled())
      expect(create.mock.calls[0][0].interval).toBe('5m')
    } finally {
      create.mockRestore()
    }
  })
})

/*
 * The Strategy panel is unmounted by focus mode, by the Analysis tab and by
 * collapsing its column -- any of which can happen while "Testing..." is on
 * the button. The run's state lived in this panel's own mutation, so a remount
 * mid-run offered the button again, and a failure that landed while the panel
 * was away was never shown.
 */
describe('a run that outlives the panel', () => {
  const H = 3_600_000
  const base = 1_780_000_000_000 - (1_780_000_000_000 % H)
  const hourly: Candle[] = Array.from({ length: 60 }, (_, index) => ({
    symbol: 'NQ',
    time: base + index * H,
    open: 1,
    high: 2,
    low: 0.5,
    close: 1.5,
    volume: 1,
  }))

  beforeEach(() => {
    useBars.mockReturnValue({ data: { bars: hourly }, isLoading: false, isError: false })
    useWorkspace.setState({
      primarySymbol: 'NQ',
      activeBacktestId: null,
      runError: null,
      selection: {
        symbol: 'NQ',
        start_time: base + 10 * H,
        end_time: base + 14 * H,
        source_interval: '1h',
      },
    })
  })

  /** Mount, start a run, unmount, and mount again -- all on one client. */
  async function runThenRemount() {
    let settle: { resolve: (value: unknown) => void; reject: (error: Error) => void } | null =
      null
    const create = vi.spyOn(api, 'createBacktest').mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          settle = { resolve, reject }
        }) as never,
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <StrategyPanel />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole('button', { name: /Test strategy/ }))
    await waitFor(() => expect(create).toHaveBeenCalled())

    view.rerender(
      <QueryClientProvider client={client}>
        <div />
      </QueryClientProvider>,
    )
    view.rerender(
      <QueryClientProvider client={client}>
        <StrategyPanel />
      </QueryClientProvider>,
    )
    return { create, settle: () => settle! }
  }

  it('stays disabled after a remount while the run is still going', async () => {
    const { create, settle } = await runThenRemount()
    try {
      expect(screen.getByRole('button', { name: /Testing/ })).toBeDisabled()

      settle().resolve({ id: 'new-run', trades: [], matches: [], summary: null })
      await waitFor(() => expect(useWorkspace.getState().activeBacktestId).toBe('new-run'))
      expect(screen.getByRole('button', { name: /Test strategy/ })).not.toBeDisabled()
    } finally {
      create.mockRestore()
    }
  })

  it('shows a failure that landed while the panel was away', async () => {
    const { create, settle } = await runThenRemount()
    try {
      settle().reject(new Error('A backtest is already running. Wait for it to finish.'))

      expect(await screen.findByText(/A backtest is already running/)).toBeInTheDocument()
    } finally {
      create.mockRestore()
    }
  })
})

/*
 * Every field below used to publish whatever was typed, red border and all.
 * The backend then refused the run with "The configuration could not be used
 * as entered", which names no field: a bar count of 2.5, a stop of 0, a
 * retracement band upside down. These settings now keep their last good value
 * while the field shows what was typed, marked.
 */
describe('values the backend would refuse', () => {
  type State = ReturnType<typeof useWorkspace.getState>

  beforeEach(() => {
    useWorkspace.setState({
      rules: DEFAULT_TRADE_RULES,
      search: DEFAULT_SEARCH_CONFIG,
      learning: DEFAULT_LEARNING_SETTINGS,
      testWindow: null,
    })
  })

  /** Sections that start folded and have to be opened to reach the field. */
  const FOLDED = new Set(['Conditions', 'Advanced'])

  const cases: [string, string, string, (state: State) => number][] = [
    ['Test window', 'Lookback', '30.5', (state) => state.search.lookbackDays],
    ['Trade rules', 'Stop value', '0', (state) => state.rules.stop_loss_value],
    ['Trade rules', 'Target value', '0', (state) => state.rules.take_profit_value],
    ['Conditions', 'Look back', '2.5', (state) => state.detectors.within_bars],
    ['Conditions', 'Swing strength', '2.5', (state) => state.detectors.swing_strength],
    ['Advanced', 'Max hold', '10.5', (state) => state.rules.maximum_holding_bars],
    ['Advanced', 'Max matches', '2.5', (state) => state.search.maximumMatches],
  ]

  it.each(cases)('%s / %s keeps %s out of the run', (section, label, typed, read) => {
    const before = read(useWorkspace.getState())
    renderPanel()
    if (FOLDED.has(section)) openDisclosure(new RegExp(`^${section}`))

    // By prefix: a field's unit -- "d", "bars" -- is part of its label text.
    const field = () => screen.getByLabelText(new RegExp(`^${label}`))
    fireEvent.change(field(), { target: { value: typed } })

    expect(read(useWorkspace.getState())).toBe(before)
    expect(field()).toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps a fractional ATR period out of the run', () => {
    useWorkspace.setState({
      rules: { ...DEFAULT_TRADE_RULES, stop_loss_type: 'atr_multiple' },
    })
    renderPanel()
    openDisclosure(/^Advanced/)

    fireEvent.change(screen.getByLabelText('ATR period'), { target: { value: '14.5' } })

    expect(useWorkspace.getState().rules.atr_period).toBe(DEFAULT_TRADE_RULES.atr_period)
  })

  it('keeps a fractional query count out of the run', () => {
    useWorkspace.setState({ learning: { ...DEFAULT_LEARNING_SETTINGS, enabled: true } })
    renderPanel()
    openDisclosure(/^Fitted weights/)

    fireEvent.change(screen.getByLabelText(/^Ask from/), { target: { value: '60.5' } })

    expect(useWorkspace.getState().learning.query_samples).toBe(
      DEFAULT_LEARNING_SETTINGS.query_samples,
    )
  })

  it('will not turn the retracement band upside down', () => {
    useWorkspace.setState({
      detectors: { ...DEFAULT_DETECTOR_FILTERS, entry_model: 'fib_retrace' },
    })
    renderPanel()
    openDisclosure(/^Entry/)

    fireEvent.change(screen.getByLabelText('From'), { target: { value: '0.9' } })

    expect(useWorkspace.getState().detectors.fib_low).toBe(DEFAULT_DETECTOR_FILTERS.fib_low)
    expect(screen.getByLabelText('From')).toHaveAttribute('aria-invalid', 'true')
  })
})
