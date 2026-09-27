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
import { fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { StrategyPanel } from '@/components/panels/StrategyPanel'
import { useWorkspace } from '@/store/workspace'
import { DEFAULT_DETECTOR_FILTERS, SESSION_KEYS, SESSION_LABELS } from '@/types/backtest'

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
    // On 1h the backend accepts 90m upward. 1h itself, or anything finer,
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

    expect(offered).toEqual(['90m', '4h', '6h', '1d', '1w', '1mo'])
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
