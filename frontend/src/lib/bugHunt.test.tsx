import { fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { StrategyStart } from '@/components/panels/StrategyStart'
import { IntervalPicker } from '@/components/layout/IntervalPicker'
import { buildBacktestRequest } from '@/hooks/useBacktest'
import { applyPreset, STRATEGY_PRESETS } from '@/lib/presets'
import { interpret } from '@/lib/strategyLanguage'
import { resolveLevels } from '@/lib/sizing'
import { canReadBias, coarserOf, useWorkspace } from '@/store/workspace'
import { DEFAULT_DETECTOR_FILTERS, DEFAULT_SEARCH_CONFIG, DEFAULT_TRADE_RULES } from '@/types/backtest'
import type { Candle } from '@/types/market'

beforeEach(() => useWorkspace.setState({ interval: '1h', rules: DEFAULT_TRADE_RULES,
  search: DEFAULT_SEARCH_CONFIG, detectors: DEFAULT_DETECTOR_FILTERS }))

describe('strategy boundary regressions', () => {
  it.each(['short after a long wick', 'short after buy-side liquidity is swept',
    'short on a long upper wick'])('does not flip %s to long', (text) => {
    expect(interpret(text).rules.direction).toBe('short')
  })

  it.each(['stop loss of 1%', 'stop-loss 1%', 'stop loss at 1%'])('reads %s', (text) => {
    expect(interpret(text).rules.stop_loss_value).toBe(1)
  })

  it('limits descriptions to inputs the backend accepts', () => {
    const read = interpret('top 999 matches, hold 9999 bars, within 999 bars, similarity 999, last 9999 days')
    expect(read.search).toMatchObject({ maximumMatches: 25, minimumSimilarity: 1, lookbackDays: 730 })
    expect(read.rules.maximum_holding_bars).toBe(2000)
    expect(read.detectors.within_bars).toBe(500)
  })

  it('never emits a zero percentage stop or reward', () => {
    const read = interpret('0% stop, target 0R')
    expect(read.rules.stop_loss_value).toBeGreaterThan(0)
    expect(read.rules.take_profit_value).toBeGreaterThan(0)
  })

  it('every built-in preset stays within the match cap', () => {
    for (const preset of STRATEGY_PRESETS) expect(applyPreset(preset).search.maximumMatches).toBeLessThanOrEqual(25)
  })

  it('reading a description clears settings it never mentioned', () => {
    useWorkspace.setState({ rules: { ...DEFAULT_TRADE_RULES, fee_percent: 3 },
      search: { ...DEFAULT_SEARCH_CONFIG, searchSymbols: ['YM'], maximumMatches: 7 },
      detectors: { ...DEFAULT_DETECTOR_FILTERS, require_fair_value_gap: true } })
    render(<StrategyStart />)
    fireEvent.click(screen.getByRole('button', { name: /Start from/ }))
    fireEvent.change(screen.getByLabelText('Strategy description'), { target: { value: 'short, 2% stop' } })
    fireEvent.click(screen.getByRole('button', { name: /Read it/ }))
    expect(useWorkspace.getState().search).toEqual(DEFAULT_SEARCH_CONFIG)
    expect(useWorkspace.getState().detectors).toEqual(DEFAULT_DETECTOR_FILTERS)
    expect(useWorkspace.getState().rules.fee_percent).toBe(DEFAULT_TRADE_RULES.fee_percent)
  })

  it('repairs a saved incompatible bias and oversized match count at request time', () => {
    const req = buildBacktestRequest({ selection: { symbol: 'ES', start_time: 1, end_time: 10,
      source_interval: '1h' }, primarySymbol: 'ES', symbols: ['ES'], interval: '1h',
      rules: DEFAULT_TRADE_RULES, search: { ...DEFAULT_SEARCH_CONFIG, maximumMatches: 100 },
      detectors: { ...DEFAULT_DETECTOR_FILTERS, require_higher_timeframe_bias: true },
      higherTimeframe: '90m', rangeEnd: 100 })
    expect(req.higher_timeframe).toBe('4h')
    expect(req.search.maximum_matches).toBe(25)
  })

  it('offers whole-bar higher timeframes only', () => {
    expect(coarserOf('90m', '1h')).toBe('4h')
    expect(coarserOf('6h', '4h')).toBe('1d')
    expect(canReadBias('1w')).toBe(false)
  })

  it('sizes a liquidity target using the minimum R floor', () => {
    const candles: Candle[] = [0, 1, 2].map(time => ({ symbol: 'ES', time, open: 100,
      high: 101, low: 99, close: 100, volume: 1 }))
    const result = resolveLevels(candles, { startIndex: 0, endIndex: 2 }, {
      ...DEFAULT_TRADE_RULES, fee_percent: 0, slippage_percent: 0,
      take_profit_type: 'liquidity', take_profit_value: 1.5 })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.levels.target).toBe(101.5)
  })

  it('closes the menu when an interval is picked from the strip', () => {
    render(<IntervalPicker />)
    fireEvent.click(screen.getByRole('button', { name: 'All timeframes' }))
    fireEvent.click(within(screen.getAllByRole('group')[0]).getByRole('button', { name: '5m' }))
    expect(screen.getByRole('button', { name: 'All timeframes' })).toHaveAttribute('aria-expanded', 'false')
  })
})
