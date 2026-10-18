import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { GxtStrategyPanel } from '@/components/panels/GxtStrategyPanel'
import { GxtTradeEvidence } from '@/components/panels/GxtTradeEvidence'
import { buildGxtRequest } from '@/hooks/useBacktest'
import { useWorkspace } from '@/store/workspace'
import { DEFAULT_GXT_SETTINGS, DEFAULT_SEARCH_CONFIG, DEFAULT_TRADE_RULES, type GxtEvidence, type Trade } from '@/types/backtest'

const mutate = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useBacktest', async (original) => ({
  ...await original<typeof import('@/hooks/useBacktest')>(),
  useRunBacktest: () => ({ mutate, isPending: false, isError: false }),
}))

beforeEach(() => {
  mutate.mockReset()
  useWorkspace.setState({
    primarySymbol: 'NQ', compareSymbols: ['ES'], interval: '1h', selection: null,
    testWindow: null, gxt: { ...DEFAULT_GXT_SETTINGS },
    rules: { ...DEFAULT_TRADE_RULES }, search: { ...DEFAULT_SEARCH_CONFIG },
  })
})

describe('GXT research workflow', () => {
  it('can run without a selected example and preserves the research identity', () => {
    render(<GxtStrategyPanel />)
    fireEvent.click(screen.getByRole('button', { name: 'Backtest GXT research' }))
    const request = mutate.mock.calls[0][0]
    expect(request.strategy).toBe('gxt_research')
    expect(request.trade.entry_type).toBe('next_open')
    expect(request.learning.enabled).toBe(false)
    expect(request.search.search_symbols).toEqual(['NQ'])
    expect(request.symbols).toEqual(['NQ', 'ES'])
    expect(screen.getByText(/not a trained GXT network/)).toBeInTheDocument()
  })

  it('blocks unsupported timeframes and absent comparison markets', () => {
    useWorkspace.setState({ interval: '4h', compareSymbols: [] })
    render(<GxtStrategyPanel />)
    expect(screen.getByRole('button', { name: 'Backtest GXT research' })).toBeDisabled()
    expect(screen.getByText(/Enable an ES, NQ or YM/)).toBeInTheDocument()
  })

  it('uses the actual window rather than an unrelated pattern selection', () => {
    const request = buildGxtRequest({
      primarySymbol: 'NQ', symbols: ['NQ', 'ES'], interval: '5m',
      rules: DEFAULT_TRADE_RULES, search: DEFAULT_SEARCH_CONFIG, gxt: DEFAULT_GXT_SETTINGS,
      rangeEnd: 10_000, testWindow: { start_time: 8_000, end_time: 4_000 },
    })
    expect(request.search.lookback_start).toBe(4_000)
    expect(request.search.lookback_end).toBe(8_000)
    expect(request.selection).toEqual({ start_time: 4_000, end_time: 8_000 })
    expect(request.detectors.require_fair_value_gap).toBe(false)
  })

  it('explains saved rule evidence without presenting a similarity score', () => {
    const evidence: GxtEvidence = {
      direction: 'long', profile: 'bullish_sweep_reclaim', context_start: 1_000,
      context_end: 2_000, confirmed_at: 3_000, signal_bar_time: 2_500,
      swept_level: 100, stop_price: 97.75, target_price: 140,
      gap_bottom: 105, gap_top: 107, reference_symbols: ['ES'],
      opposed_close_symbols: ['ES'], entry_session_ny: '2026-01-06T05:00:00-05:00',
      steps: ['C2 swept the prior low and reclaimed the range.'],
    }
    const trade = {
      trade_number: 1, direction: 'long', symbol: 'NQ', entry_price: 109,
      stop_price: 97.75, target_price: 140, same_bar_ambiguity: true,
      exit_reason: 'stop_loss',
    } as Trade
    render(<GxtTradeEvidence trade={trade} evidence={evidence} />)
    expect(screen.getByText(/C2 swept the prior low/)).toBeInTheDocument()
    expect(screen.getByText(/not a verified PSP/)).toBeInTheDocument()
    expect(screen.getByText(/stop assumed first/)).toBeInTheDocument()
    expect(screen.queryByText(/similarity/)).not.toBeInTheDocument()
  })
})
