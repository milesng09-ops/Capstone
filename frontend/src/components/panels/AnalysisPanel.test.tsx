/**
 * The analysis panel: what it asks the detectors for, and what it lists back.
 *
 * Three regressions, each of which looked fine in the panel itself. With the
 * interval link off it asked for the *shared* interval's detections while the
 * primary chart drew its own, so the counts beside the switches described a
 * different timeframe from the one on screen. A swing strength of 2.5 went
 * straight into the request, which the backend refuses as a non-integer --
 * every detection left the chart. And the liquidity rows used two class names
 * that exist nowhere in the Tailwind config.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { AnalysisPanel } from '@/components/panels/AnalysisPanel'
import { useWorkspace } from '@/store/workspace'
import { DEFAULT_CHART_SYNC } from '@/types/market'
import { DEFAULT_ICT_SETTINGS, type IctAnalysis } from '@/types/ict'

const useIct = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useMarketData', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useMarketData')>()),
  useIct,
}))

const ANALYSIS: IctAnalysis = {
  symbol: 'NQ',
  interval: '5m',
  from_time: 0,
  to_time: 1,
  provider: 'cached',
  bars_analysed: 400,
  swing_strength: 2,
  reference_symbols: [],
  swing_points: [],
  fair_value_gaps: [],
  smt_divergences: [],
  liquidity_pools: [
    {
      kind: 'high',
      symbol: 'NQ',
      price: 21_000,
      start_time: 1_780_000_000_000,
      end_time: 1_780_000_900_000,
      formed_time: 1_780_000_900_000,
      touch_count: 3,
      spread: 1.25,
      spread_percent: 0.006,
      swept: false,
      swept_time: null,
    },
  ],
  warnings: [],
}

beforeEach(() => {
  useIct.mockReset()
  useIct.mockReturnValue({
    data: ANALYSIS,
    isLoading: false,
    isError: false,
    isFetching: false,
  })
  useWorkspace.setState({
    primarySymbol: 'NQ',
    compareSymbols: [],
    interval: '1h',
    rangeDays: 180,
    chartSync: DEFAULT_CHART_SYNC,
    intervalOverrides: {},
    ict: DEFAULT_ICT_SETTINGS,
    drawings: [],
  })
})

describe('what the panel asks for', () => {
  it('asks for the interval the primary chart is actually drawn on', () => {
    useWorkspace.setState({
      chartSync: { ...DEFAULT_CHART_SYNC, interval: false },
      intervalOverrides: { NQ: '5m' },
    })
    render(<AnalysisPanel />)

    const [symbol, interval, from, to] = useIct.mock.calls.at(-1)!
    expect(symbol).toBe('NQ')
    expect(interval).toBe('5m')
    // And over the window that pane can load: 90 days of 5m, not the 180 the
    // shared 1h range holds -- otherwise it is a different request from the
    // chart's, which the backend refuses for its bar count anyway.
    expect(to - from).toBeLessThanOrEqual(90 * 24 * 3_600_000)
  })

  it('keeps a fractional swing strength out of the request', () => {
    render(<AnalysisPanel />)
    fireEvent.change(screen.getByLabelText('Swing strength'), { target: { value: '2.5' } })

    expect(useWorkspace.getState().ict.swingStrength).toBe(DEFAULT_ICT_SETTINGS.swingStrength)
    expect(screen.getByLabelText('Swing strength')).toHaveAttribute('aria-invalid', 'true')
  })

  it('keeps a fractional touch count out of the request', () => {
    render(<AnalysisPanel />)
    fireEvent.change(screen.getByLabelText('Min touches'), { target: { value: '2.5' } })

    expect(useWorkspace.getState().ict.liquidityMinTouches).toBe(
      DEFAULT_ICT_SETTINGS.liquidityMinTouches,
    )
  })
})

describe('what the panel lists', () => {
  it('draws liquidity rows with classes the stylesheet actually has', () => {
    const { container } = render(<AnalysisPanel />)

    expect(screen.getByText('Equal highs')).toBeInTheDocument()
    expect(container.querySelectorAll('.bg-surface-2, .text-fg')).toHaveLength(0)
  })
})
