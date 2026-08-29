import { describe, expect, it } from 'vitest'

import {
  applySlippage,
  averageTrueRange,
  netReturnPercent,
  planPosition,
  resolveLevels,
  trueRanges,
} from '@/lib/sizing'
import { DEFAULT_TRADE_RULES, type TradeRules } from '@/types/backtest'
import type { Candle } from '@/types/market'

/** A flat series of identical bars, so any variation comes from the override. */
function bars(specs: Partial<Candle>[]): Candle[] {
  return specs.map((spec, index) => ({
    symbol: 'NQ',
    time: index * 3_600_000,
    open: 100,
    high: 100,
    low: 100,
    close: 100,
    volume: 1,
    ...spec,
  }))
}

/** Costless rules, so a test only pays for what it opts into. */
function rules(overrides: Partial<TradeRules> = {}): TradeRules {
  return {
    ...DEFAULT_TRADE_RULES,
    fee_percent: 0,
    slippage_percent: 0,
    ...overrides,
  }
}

const WINDOW = { startIndex: 0, endIndex: 2 }

describe('resolveLevels', () => {
  it('places a percentage stop and a risk/reward target around the entry', () => {
    const result = resolveLevels(
      bars([{}, {}, { close: 100 }]),
      WINDOW,
      rules({ stop_loss_type: 'percentage', stop_loss_value: 1, take_profit_value: 2 }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.levels.entry).toBeCloseTo(100, 8)
    expect(result.levels.stop).toBeCloseTo(99, 8)
    // Two times the one-point risk, above the entry for a long.
    expect(result.levels.target).toBeCloseTo(102, 8)
  })

  it('mirrors the levels for a short', () => {
    const result = resolveLevels(
      bars([{}, {}, { close: 100 }]),
      WINDOW,
      rules({ direction: 'short', stop_loss_value: 1, take_profit_value: 2 }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.levels.stop).toBeCloseTo(101, 8)
    expect(result.levels.target).toBeCloseTo(98, 8)
  })

  it('measures the stop from the slipped entry, not from the price on the chart', () => {
    // The engine worsens the entry first and only then places the stop, so a
    // 1% stop on a 100.00 close sits at 99.0099, not at 99.00.
    const result = resolveLevels(
      bars([{}, {}, { close: 100 }]),
      WINDOW,
      rules({ slippage_percent: 0.01, stop_loss_value: 1 }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.levels.entry).toBeCloseTo(100.01, 8)
    expect(result.levels.stop).toBeCloseTo(100.01 * 0.99, 8)
  })

  it('takes a pattern-extreme stop from the low of the selected window only', () => {
    const candles = bars([
      { low: 97 },
      { low: 95 },
      { low: 98, close: 100 },
      // Beyond the selection: must not be considered.
      { low: 80 },
    ])

    const result = resolveLevels(
      candles,
      WINDOW,
      rules({ stop_loss_type: 'pattern_extreme' }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.levels.stop).toBeCloseTo(95, 8)
  })

  it('uses the open of the following candle for a next-open entry', () => {
    const candles = bars([{}, {}, { close: 100 }, { open: 104 }])

    const result = resolveLevels(candles, WINDOW, rules({ entry_type: 'next_open' }))

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.levels.entry).toBeCloseTo(104, 8)
  })

  it('refuses a next-open entry when the pattern ends at the last candle', () => {
    const result = resolveLevels(
      bars([{}, {}, { close: 100 }]),
      WINDOW,
      rules({ entry_type: 'next_open' }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem).toMatch(/no candle available/i)
  })

  it('rejects a fixed stop on the wrong side of a long entry', () => {
    const result = resolveLevels(
      bars([{}, {}, { close: 100 }]),
      WINDOW,
      rules({ stop_loss_type: 'fixed_price', stop_loss_value: 101 }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem).toMatch(/at or above the entry price/i)
  })

  it('rejects a fixed target on the wrong side of a long entry', () => {
    const result = resolveLevels(
      bars([{}, {}, { close: 100 }]),
      WINDOW,
      rules({ take_profit_type: 'fixed_price', take_profit_value: 99 }),
    )

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem).toMatch(/at or below the entry price/i)
  })

  it('offsets an ATR stop by the mean true range over the period', () => {
    // Ranges: bar 0 is high-low; the rest include the gap from the previous
    // close. Every bar here has a true range of exactly 2.
    const candles = bars([
      { high: 101, low: 99, close: 100 },
      { high: 101, low: 99, close: 100 },
      { high: 101, low: 99, close: 100 },
    ])

    const result = resolveLevels(
      candles,
      WINDOW,
      rules({ stop_loss_type: 'atr_multiple', stop_loss_value: 1.5, atr_period: 3 }),
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.levels.stop).toBeCloseTo(100 - 2 * 1.5, 8)
  })
})

describe('trueRanges and averageTrueRange', () => {
  it('falls back to high - low on the first bar, which has no previous close', () => {
    expect(trueRanges(bars([{ high: 105, low: 100 }]))[0]).toBeCloseTo(5, 8)
  })

  it('counts a gap from the previous close as range', () => {
    const ranges = trueRanges(
      bars([
        { high: 100, low: 100, close: 100 },
        // Opens and trades far above the previous close.
        { high: 110, low: 108, close: 109 },
      ]),
    )
    expect(ranges[1]).toBeCloseTo(10, 8)
  })

  it('averages only the bars inside the period', () => {
    const ranges = [0, 1, 2, 3, 9]
    // Period 2 ending at index 3 covers ranges 2 and 3.
    expect(averageTrueRange(ranges, 3, 2)).toBeCloseTo(2.5, 8)
  })

  it('has no window at index 0 and reports zero', () => {
    expect(averageTrueRange([5, 1, 1], 0, 14)).toBe(0)
  })
})

describe('netReturnPercent', () => {
  it('charges the fee twice, once each way', () => {
    // A flat exit at the entry still costs 2 x 0.02%.
    expect(netReturnPercent(100, 100, rules({ fee_percent: 0.02 }), true)).toBeCloseTo(
      -0.04,
      8,
    )
  })

  it('worsens the exit against the position in both directions', () => {
    expect(applySlippage(100, 0.5, false)).toBeCloseTo(99.5, 8)
    expect(applySlippage(100, 0.5, true)).toBeCloseTo(100.5, 8)
  })
})

describe('planPosition', () => {
  const levels = { entry: 100, stop: 99, target: 102 }

  it('sizes so that the stop costs exactly the risk budget', () => {
    const result = planPosition(levels, rules(), 100_000, 1)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { plan } = result
    expect(plan.riskAmount).toBeCloseTo(1_000, 8)
    expect(plan.estimatedLoss).toBeCloseTo(1_000, 8)
    // A 1% stop with a 1% budget means the whole account is the notional.
    expect(plan.notional).toBeCloseTo(100_000, 6)
    expect(plan.units).toBeCloseTo(1_000, 6)
    expect(plan.estimatedProfit).toBeCloseTo(2_000, 6)
    expect(plan.rewardToRisk).toBeCloseTo(2, 8)
  })

  it('shrinks the position and the profit once fees are charged', () => {
    const costed = planPosition(levels, rules({ fee_percent: 0.02 }), 100_000, 1)
    const free = planPosition(levels, rules(), 100_000, 1)

    expect(costed.ok && free.ok).toBe(true)
    if (!costed.ok || !free.ok) return

    // The stop now costs 1.04% instead of 1%, so less notional fits the budget.
    expect(costed.plan.stopReturnPercent).toBeCloseTo(-1.04, 8)
    expect(costed.plan.notional).toBeLessThan(free.plan.notional)
    // The loss is still the budget -- that is what being sized to risk means.
    expect(costed.plan.estimatedLoss).toBeCloseTo(1_000, 8)
    expect(costed.plan.estimatedProfit).toBeLessThan(free.plan.estimatedProfit)
    expect(costed.plan.rewardToRisk).toBeLessThan(2)
  })

  it('scales linearly with the risk percentage', () => {
    const one = planPosition(levels, rules(), 100_000, 1)
    const two = planPosition(levels, rules(), 100_000, 2)

    expect(one.ok && two.ok).toBe(true)
    if (!one.ok || !two.ok) return
    expect(two.plan.notional).toBeCloseTo(one.plan.notional * 2, 6)
    expect(two.plan.estimatedProfit).toBeCloseTo(one.plan.estimatedProfit * 2, 6)
  })

  it('reports a negative profit when costs exceed the move to the target', () => {
    const result = planPosition(
      { entry: 100, stop: 99, target: 100.01 },
      rules({ fee_percent: 0.05 }),
      100_000,
      1,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.estimatedProfit).toBeLessThan(0)
    expect(result.plan.rewardToRisk).toBeLessThan(0)
  })

  it('refuses to size when the stop costs nothing', () => {
    const result = planPosition({ entry: 100, stop: 100, target: 102 }, rules(), 100_000, 1)

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.problem).toMatch(/no risk to size against/i)
  })

  it('refuses to size against an empty account or a zero risk', () => {
    expect(planPosition(levels, rules(), 0, 1).ok).toBe(false)
    expect(planPosition(levels, rules(), 100_000, 0).ok).toBe(false)
  })

  it('sizes a short the same way it sizes a long', () => {
    const result = planPosition(
      { entry: 100, stop: 101, target: 98 },
      rules({ direction: 'short' }),
      100_000,
      1,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.plan.estimatedLoss).toBeCloseTo(1_000, 8)
    expect(result.plan.estimatedProfit).toBeCloseTo(2_000, 6)
  })
})
