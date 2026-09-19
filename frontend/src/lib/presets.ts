/**
 * Starting points, not recommendations.
 *
 * Miles and Herdy converged on preset strategies before any attempt at
 * interpreting a written description: a blank form with a dozen fields asks
 * you to have already decided everything, and the fastest way to learn what
 * the fields *do* is to load an arrangement that hangs together and change
 * one thing.
 *
 * **What a preset is not.** None of these is claimed to work. Every one is a
 * hypothesis someone could reasonably hold, expressed in the settings the
 * engine understands, and the whole point of the app is that it will tell you
 * whether the hypothesis survives contact with the data -- with an interval,
 * against a random-entry baseline, priced for how many configurations have
 * been tried. A preset that arrived with a win rate attached would be exactly
 * the thing this tool exists to argue against.
 *
 * They are deliberately sparse: each sets only the fields its idea is about
 * and leaves the rest at their defaults, so the diff from the default form is
 * the idea itself.
 */

import {
  DEFAULT_DETECTOR_FILTERS,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_TRADE_RULES,
  type DetectorFilters,
  type SearchConfig,
  type TradeRules,
} from '@/types/backtest'

export interface StrategyPreset {
  id: string
  name: string
  /** One line, shown in the list. */
  summary: string
  /** What the idea is, and what it assumes. Shown once chosen. */
  rationale: string
  rules?: Partial<TradeRules>
  search?: Partial<SearchConfig>
  detectors?: Partial<DetectorFilters>
}

export const STRATEGY_PRESETS: StrategyPreset[] = [
  {
    id: 'gap-continuation',
    name: 'Gap continuation',
    summary: 'Enter inside an unfilled fair value gap, 1% stop, 2R target.',
    rationale:
      'The idea every ICT reading of a chart starts from: an imbalance left ' +
      'behind by a fast move is unfinished business, and price returning ' +
      'into it continues in the direction that made it. The condition is ' +
      'strict -- the entry bar must sit inside a gap that was still unfilled ' +
      'at that moment, which is about one bar in nine on hourly index ' +
      'futures, so the match count will be far lower than the default search.',
    rules: {
      direction: 'long',
      stop_loss_type: 'percentage',
      stop_loss_value: 1,
      take_profit_type: 'risk_reward',
      take_profit_value: 2,
      maximum_holding_bars: 24,
    },
    detectors: {
      require_fair_value_gap: true,
      align_with_direction: true,
    },
  },
  {
    id: 'smt-reversal',
    name: 'SMT divergence reversal',
    summary: 'Take the turn when the correlated market refuses to confirm.',
    rationale:
      'When NQ makes a new high and ES does not, one of the two is lying ' +
      'about the move. This trades the reversal, so the stop sits at the ' +
      'extreme of the pattern rather than at a fixed percentage -- the trade ' +
      'is wrong precisely when that extreme gives way. Needs both markets ' +
      'charted, since a divergence is a statement about a pair.',
    rules: {
      direction: 'short',
      stop_loss_type: 'pattern_extreme',
      stop_loss_value: 0,
      take_profit_type: 'risk_reward',
      take_profit_value: 2,
      maximum_holding_bars: 18,
    },
    detectors: {
      require_smt_divergence: true,
      within_bars: 5,
      align_with_direction: true,
    },
  },
  {
    id: 'structure-break',
    name: 'Structure break',
    summary: 'Trade with a freshly confirmed swing, stop beyond it.',
    rationale:
      'Market structure read the plain way: a confirmed swing says the last ' +
      'attempt in the other direction failed. The swing must have been ' +
      'confirmed within ten bars, because a level from three sessions ago is ' +
      'not what broke -- and confirmation, not the pivot itself, is the ' +
      'moment it was knowable.',
    rules: {
      direction: 'long',
      stop_loss_type: 'pattern_extreme',
      stop_loss_value: 0,
      take_profit_type: 'risk_reward',
      take_profit_value: 2.5,
      maximum_holding_bars: 36,
    },
    detectors: {
      require_swing_point: true,
      within_bars: 10,
      swing_strength: 3,
    },
  },
  {
    id: 'liquidity-sweep',
    name: 'Liquidity sweep',
    summary: 'Enter after the lows are taken, target the next shelf of highs.',
    rationale:
      'The setup Miles walked through on the chart: a shelf of equal lows is ' +
      'where stops rest, price dips under it to take them, and the move that ' +
      'took them has no follow-through. Both halves are liquidity -- the ' +
      'trigger is the shelf behind the trade being cleared, and the target is ' +
      'the nearest shelf standing in front of it, not a multiple of risk. ' +
      'The minimum reward is what keeps that honest: a shelf a few points ' +
      'away fills almost every time, and a run of those reports a superb win ' +
      'rate for a strategy that loses money, so anything under 1.5R skips the ' +
      'match and says so rather than being traded.',
    rules: {
      direction: 'long',
      stop_loss_type: 'pattern_extreme',
      stop_loss_value: 0,
      take_profit_type: 'liquidity',
      take_profit_value: 1.5,
      maximum_holding_bars: 30,
    },
    detectors: {
      require_liquidity_sweep: true,
      within_bars: 8,
      align_with_direction: true,
    },
  },
  {
    id: 'volatility-scalp',
    name: 'Volatility scalp',
    summary: 'ATR stop, quick 1.5R, out within eight bars.',
    rationale:
      'A stop measured in the volatility the market actually has rather than ' +
      'in a fixed percentage, which is the difference between a stop that ' +
      'means something in August and one that means something in a selloff. ' +
      'Short holding period, so costs matter: at 1.5 ATR and 1.5R the fee ' +
      'and slippage assumptions are a larger share of the result than they ' +
      'are anywhere else on this list.',
    rules: {
      direction: 'long',
      stop_loss_type: 'atr_multiple',
      stop_loss_value: 1.5,
      atr_period: 14,
      take_profit_type: 'risk_reward',
      take_profit_value: 1.5,
      maximum_holding_bars: 8,
    },
    search: {
      maximumMatches: 50,
      minimumSimilarity: 0.65,
    },
  },
  {
    id: 'patient-swing',
    name: 'Patient swing',
    summary: 'Wide stop, 3R target, held up to five days of bars.',
    rationale:
      'The opposite end of the same question: few trades, each given room ' +
      'and time. A 2% stop against a 3R target needs to be right about a ' +
      'quarter of the time to break even, which is a far weaker requirement ' +
      'than the scalp -- and a far smaller sample, so the interval on the ' +
      'win rate will be correspondingly wide. Read it with the baseline.',
    rules: {
      direction: 'long',
      stop_loss_type: 'percentage',
      stop_loss_value: 2,
      take_profit_type: 'risk_reward',
      take_profit_value: 3,
      maximum_holding_bars: 120,
    },
    search: {
      lookbackDays: 365,
      minimumSimilarity: 0.55,
    },
  },
]

export function findPreset(id: string): StrategyPreset | undefined {
  return STRATEGY_PRESETS.find((preset) => preset.id === id)
}

/**
 * A preset resolved against the defaults, not against what is on the form.
 *
 * Choosing a preset replaces the strategy rather than editing it. Merging
 * into whatever was there would make the result depend on the order presets
 * were clicked in -- a gap condition left over from one, a holding period
 * from another -- and "Gap continuation" would name an arrangement nobody
 * could reconstruct.
 */
export function applyPreset(preset: StrategyPreset): {
  rules: TradeRules
  search: SearchConfig
  detectors: DetectorFilters
} {
  return {
    rules: { ...DEFAULT_TRADE_RULES, ...preset.rules },
    search: { ...DEFAULT_SEARCH_CONFIG, ...preset.search },
    detectors: { ...DEFAULT_DETECTOR_FILTERS, ...preset.detectors },
  }
}
