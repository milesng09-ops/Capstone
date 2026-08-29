/**
 * What one trade of this setup is worth, in money.
 *
 * The backtesting engine deals only in percentages -- it says so in its own
 * assumptions list -- because contract multipliers, margin and financing are
 * out of scope. That is the right call for measuring a rule, and useless for
 * answering "so how much do I lose if I am wrong?". This module closes that
 * gap without contradicting the engine: it derives the same levels the engine
 * would, turns them into the same net percentages, and then scales those by a
 * position size chosen so that the stop costs exactly the risk budget.
 *
 * Everything here mirrors `backend/app/backtesting/engine.py` deliberately and
 * exactly -- slippage applied to the entry *before* the stop is measured from
 * it, fees as a flat `2 x fee_percent` of the entry notional, the same level
 * validation, the same mean-of-true-ranges ATR. Two implementations of one
 * model is a maintenance cost, and it is paid so that the figures on the
 * screen and the figures in the results panel cannot disagree. If the engine's
 * model changes, this changes with it.
 *
 * No contract multiplier appears anywhere below. Size is expressed as notional
 * and as units of the index, which is what a percentage return is a percentage
 * *of*. Inventing a $50-per-point multiplier here would produce dollar figures
 * that no number the backend returns could be reconciled with.
 */

import type { TradeRules } from '@/types/backtest'
import type { Candle } from '@/types/market'

/** The three prices a trade is defined by, after slippage. */
export interface Levels {
  /** Entry fill: the raw price already worsened by slippage. */
  entry: number
  stop: number
  target: number
}

/** The candles the setup was drawn across, as indices into the bar array. */
export interface SetupWindow {
  startIndex: number
  endIndex: number
}

export type LevelsResult =
  | { ok: true; levels: Levels }
  | { ok: false; problem: string }

export interface PositionPlan {
  levels: Levels
  /** Net return if the stop is hit, in percent. Negative. */
  stopReturnPercent: number
  /** Net return if the target is hit, in percent. */
  targetReturnPercent: number
  /** Currency the stop is allowed to cost: equity x risk percent. */
  riskAmount: number
  /** Position value at the entry price. */
  notional: number
  /** Notional expressed in units of the index. */
  units: number
  /** Currency lost if the stop fills. Equal to the risk budget by design. */
  estimatedLoss: number
  /** Currency made if the target fills. Negative if fees swallow the move. */
  estimatedProfit: number
  rewardToRisk: number
}

export type PlanResult =
  | { ok: true; plan: PositionPlan }
  | { ok: false; problem: string }

/** Move a price against the trader, as the engine does. */
export function applySlippage(
  price: number,
  slippagePercent: number,
  worsenUp: boolean,
): number {
  const factor = slippagePercent / 100
  return worsenUp ? price * (1 + factor) : price * (1 - factor)
}

/**
 * True range per bar, with the first bar falling back to its own high - low.
 *
 * The first bar has no previous close to gap from, so the two gap terms are
 * undefined rather than zero.
 */
export function trueRanges(candles: Candle[]): number[] {
  const ranges = new Array<number>(candles.length).fill(0)
  for (let index = 1; index < candles.length; index += 1) {
    const candle = candles[index]
    const previousClose = candles[index - 1].close
    ranges[index] = Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose),
    )
  }
  if (candles.length > 0) ranges[0] = candles[0].high - candles[0].low
  return ranges
}

/**
 * Mean true range over the `period` bars ending at `index`.
 *
 * A plain mean, not Wilder's smoothing, because that is what the engine uses
 * and the two have to agree. Index 0 has no usable window and returns 0, which
 * the caller reads as "no ATR here".
 */
export function averageTrueRange(
  ranges: number[],
  index: number,
  period: number,
): number {
  const start = Math.max(1, index - period + 1)
  const window = ranges.slice(start, index + 1)
  if (window.length === 0) return 0
  return window.reduce((total, value) => total + value, 0) / window.length
}

/**
 * Entry, stop and target for a setup, exactly as the engine would place them.
 *
 * Order matters and is not obvious: slippage worsens the entry first, and the
 * stop is then measured from that worsened price rather than from the price on
 * the chart. A percentage stop therefore sits slightly further away than the
 * percentage alone implies, and the engine's own risk is measured the same way.
 */
export function resolveLevels(
  candles: Candle[],
  window: SetupWindow,
  rules: TradeRules,
): LevelsResult {
  const { startIndex, endIndex } = window
  if (
    startIndex < 0 ||
    endIndex < startIndex ||
    endIndex >= candles.length ||
    candles.length === 0
  ) {
    return { ok: false, problem: 'The selected candles are not on the chart.' }
  }

  const long = rules.direction === 'long'

  let rawEntry: number
  if (rules.entry_type === 'next_open') {
    const next = candles[endIndex + 1]
    if (!next) {
      return {
        ok: false,
        problem: 'No candle available after the pattern for a next-open entry.',
      }
    }
    rawEntry = next.open
  } else {
    rawEntry = candles[endIndex].close
  }

  if (!Number.isFinite(rawEntry) || rawEntry <= 0) {
    return { ok: false, problem: 'The entry candle has no usable price.' }
  }

  const entry = applySlippage(rawEntry, rules.slippage_percent, long)

  const stop = resolveStop(candles, window, rules, entry, long)
  if (stop == null) {
    return { ok: false, problem: 'ATR could not be computed for this setup.' }
  }

  const target = resolveTarget(rules, entry, stop, long)
  if (target == null) {
    return {
      ok: false,
      problem: 'The stop sits at the entry price, so risk is zero.',
    }
  }

  // The same checks the engine runs before it will simulate a match, worded
  // the same way, so a setup that cannot be traded says so here rather than
  // silently producing a plan and then being skipped by every match.
  if (long) {
    if (stop >= entry) {
      return {
        ok: false,
        problem: 'The stop is at or above the entry price for a long trade.',
      }
    }
    if (target <= entry) {
      return {
        ok: false,
        problem: 'The target is at or below the entry price for a long trade.',
      }
    }
  } else {
    if (stop <= entry) {
      return {
        ok: false,
        problem: 'The stop is at or below the entry price for a short trade.',
      }
    }
    if (target >= entry) {
      return {
        ok: false,
        problem: 'The target is at or above the entry price for a short trade.',
      }
    }
  }

  return { ok: true, levels: { entry, stop, target } }
}

/** Null means the rule could not produce a stop for this setup. */
function resolveStop(
  candles: Candle[],
  window: SetupWindow,
  rules: TradeRules,
  entry: number,
  long: boolean,
): number | null {
  const value = rules.stop_loss_value

  switch (rules.stop_loss_type) {
    case 'percentage': {
      const offset = (entry * value) / 100
      return long ? entry - offset : entry + offset
    }
    case 'fixed_price':
      return value
    case 'pattern_extreme': {
      const slice = candles.slice(window.startIndex, window.endIndex + 1)
      if (slice.length === 0) return null
      return long
        ? Math.min(...slice.map((candle) => candle.low))
        : Math.max(...slice.map((candle) => candle.high))
    }
    case 'atr_multiple': {
      const atr = averageTrueRange(
        trueRanges(candles),
        window.endIndex,
        rules.atr_period,
      )
      if (atr <= 0) return null
      const offset = atr * value
      return long ? entry - offset : entry + offset
    }
    default:
      return null
  }
}

/** Null means the rule could not produce a target -- risk/reward on zero risk. */
function resolveTarget(
  rules: TradeRules,
  entry: number,
  stop: number,
  long: boolean,
): number | null {
  const value = rules.take_profit_value

  switch (rules.take_profit_type) {
    case 'percentage': {
      const offset = (entry * value) / 100
      return long ? entry + offset : entry - offset
    }
    case 'fixed_price':
      return value
    case 'risk_reward': {
      const risk = Math.abs(entry - stop)
      if (risk <= 0) return null
      const offset = risk * value
      return long ? entry + offset : entry - offset
    }
    default:
      return null
  }
}

/**
 * Net percentage return for exiting at `level`, the engine's arithmetic.
 *
 * Fees are a flat `2 x fee_percent` of the entry notional -- charged once on
 * the way in and once on the way out -- rather than being recomputed against
 * the exit notional. That is a simplification, and it is the engine's, so it
 * is reproduced rather than improved on.
 */
export function netReturnPercent(
  entry: number,
  level: number,
  rules: TradeRules,
  long: boolean,
): number {
  const fill = applySlippage(level, rules.slippage_percent, !long)
  const sign = long ? 1 : -1
  const gross = ((sign * (fill - entry)) / entry) * 100
  return gross - rules.fee_percent * 2
}

/**
 * Size the position so that being stopped out costs the risk budget exactly.
 *
 * This is the whole point of the exercise, and it runs backwards from the
 * usual direction: rather than picking a size and discovering what it risks,
 * the loss is fixed first and the size falls out of it. The stop distance is
 * measured *after* fees and slippage, so the budget is what actually leaves
 * the account, not what leaves it before costs.
 */
export function planPosition(
  levels: Levels,
  rules: TradeRules,
  accountEquity: number,
  riskPercent: number,
): PlanResult {
  const long = rules.direction === 'long'

  if (!(accountEquity > 0)) {
    return { ok: false, problem: 'Set an account size above zero to size a position.' }
  }
  if (!(riskPercent > 0)) {
    return { ok: false, problem: 'Set a risk above zero to size a position.' }
  }

  const stopReturnPercent = netReturnPercent(levels.entry, levels.stop, rules, long)
  const targetReturnPercent = netReturnPercent(levels.entry, levels.target, rules, long)

  const lossFraction = -stopReturnPercent / 100
  if (!(lossFraction > 0)) {
    // Reachable when fees and slippage are zero and the stop sits on the
    // entry: there is no loss to size against, so any size is "within budget".
    return {
      ok: false,
      problem: 'Being stopped out costs nothing under these rules, so there is no risk to size against.',
    }
  }

  const riskAmount = (accountEquity * riskPercent) / 100
  const notional = riskAmount / lossFraction
  const units = notional / levels.entry
  const estimatedLoss = riskAmount
  const estimatedProfit = (notional * targetReturnPercent) / 100

  return {
    ok: true,
    plan: {
      levels,
      stopReturnPercent,
      targetReturnPercent,
      riskAmount,
      notional,
      units,
      estimatedLoss,
      estimatedProfit,
      rewardToRisk: estimatedProfit / estimatedLoss,
    },
  }
}
