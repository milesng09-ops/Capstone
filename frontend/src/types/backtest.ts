/** Backtesting request/response types. Mirrors the backend schemas. */

import type { Interval, SelectionRange } from '@/types/market'

export type Direction = 'long' | 'short'
export type EntryType = 'selection_close' | 'next_open'
export type StopLossType = 'percentage' | 'fixed_price' | 'pattern_extreme' | 'atr_multiple'
export type TakeProfitType = 'percentage' | 'fixed_price' | 'risk_reward'
export type ExitReason = 'stop_loss' | 'take_profit' | 'timeout' | 'end_of_data'

export const EXIT_REASON_LABELS: Record<ExitReason, string> = {
  stop_loss: 'Stop loss',
  take_profit: 'Take profit',
  timeout: 'Timeout',
  end_of_data: 'End of data',
}

export interface TradeRules {
  direction: Direction
  entry_type: EntryType
  stop_loss_type: StopLossType
  stop_loss_value: number
  take_profit_type: TakeProfitType
  take_profit_value: number
  maximum_holding_bars: number
  fee_percent: number
  slippage_percent: number
  allow_overlapping_trades: boolean
  atr_period: number
}

export interface SearchSettings {
  lookback_start: number
  lookback_end: number
  pattern_length: number | null
  maximum_matches: number
  minimum_similarity: number
  minimum_separation_bars: number | null
  search_symbols: string[] | null
}

/**
 * Conditions a match must meet at its entry bar to be traded at all.
 *
 * All off by default, so a run that asks for nothing behaves exactly as it
 * did before the detectors could decide anything.
 */
export interface DetectorFilters {
  /** The entry price sat inside a fair value gap that was unfilled then. */
  require_fair_value_gap: boolean
  require_smt_divergence: boolean
  require_swing_point: boolean
  /** How recently a swing or divergence must have been confirmed to count. */
  within_bars: number
  align_with_direction: boolean
  swing_strength: number
}

export const DEFAULT_DETECTOR_FILTERS: DetectorFilters = {
  require_fair_value_gap: false,
  require_smt_divergence: false,
  require_swing_point: false,
  within_bars: 10,
  align_with_direction: true,
  swing_strength: 2,
}

/**
 * Phase two: fit the similarity weights rather than take them as given.
 *
 * Off by default. When on, the lookback is split in two — the weights are
 * fitted on the earlier part and the backtest runs on the later part, so the
 * result is never read off the data the model was chosen on.
 */
export interface LearningSettings {
  enabled: boolean
  /** Share of the lookback used to fit; the rest is the out-of-sample half. */
  train_fraction: number
}

export const DEFAULT_LEARNING_SETTINGS: LearningSettings = {
  enabled: false,
  train_fraction: 0.5,
}

/** A fitted weight set and what it is worth. The whole model: seven numbers. */
export interface LearnedWeightsSummary {
  weights: Record<string, number>
  train_score: number
  default_score: number
  /** Beat the defaults on its own training data. Weak evidence alone. */
  improved: boolean
  labelled_windows: number
  top_k: number
  passes: number
  objective: string
  dropped_blocks: string[]
  holdout_score: number | null
  holdout_default_score: number | null
  holdout_windows: number
  /** The verdict that matters. `null` when there was no holdout to judge on. */
  generalised: boolean | null
  train_start: number
  train_end: number
}

export interface BacktestRequest {
  symbols: string[]
  primary_symbol: string
  interval: Interval
  selection: { start_time: number; end_time: number }
  trade: TradeRules
  search: SearchSettings
  detectors: DetectorFilters
  learning: LearningSettings
}

export interface PatternMatch {
  id: string
  symbol: string
  interval: Interval
  start_time: number
  end_time: number
  similarity_score: number
  euclidean_distance: number
  entry_price: number
  rank: number
  normalized_series: number[] | null
  outcome: string | null
  net_return: number | null
}

export interface Trade {
  id: string
  trade_number: number
  pattern_match_id: string
  symbol: string
  direction: Direction
  entry_time: number
  exit_time: number
  entry_price: number
  exit_price: number
  stop_price: number
  target_price: number
  gross_return: number
  fees: number
  net_return: number
  exit_reason: ExitReason
  holding_bars: number
  similarity_score: number
  same_bar_ambiguity: boolean
}

export interface EquityPoint {
  trade_number: number
  time: number
  equity: number
  drawdown: number
}

/**
 * The same trade rules run at windows chosen at random from the pool the
 * similarity search ranked. The reference point the win rate is read against:
 * same candles, same costs, same stop and target, chance instead of
 * resemblance.
 */
export interface BaselineSummary {
  samples: number
  trades_executed: number
  win_rate: number
  average_return: number
  expectancy: number
  /** Derived from the query, so a rerun reproduces this exact draw. */
  seed: number
}

export interface BacktestSummary {
  total_matches: number
  trades_executed: number
  skipped_matches: number
  wins: number
  losses: number
  breakeven: number
  timeouts: number
  win_rate: number
  gross_return: number
  net_return: number
  average_return: number
  median_return: number
  average_winner: number
  average_loser: number
  risk_reward_achieved: number
  /** `null` when no trade lost: the ratio is undefined, not large. */
  profit_factor: number | null
  expectancy: number
  maximum_drawdown: number
  longest_winning_streak: number
  longest_losing_streak: number
  average_holding_bars: number
  /** 95% Wilson interval around `win_rate`, in percent. */
  win_rate_low: number
  win_rate_high: number
  /** `null` when there was not enough history to draw a baseline. */
  baseline: BaselineSummary | null
  /**
   * P(a win rate at least this high | no edge over the baseline). Does not
   * account for the setup being chosen by eye, nor for repeated attempts on
   * the same selection.
   */
  baseline_p_value: number | null
  /**
   * Distinct configurations run against a window overlapping this one, this
   * run included. 1 means this is the first thing tried here.
   */
  /** Present only when weights were fitted for this run. */
  learned_weights: LearnedWeightsSummary | null
  configurations_tried: number
  /** Chance that *any* of those configurations looks this good by chance. */
  family_wise_p_value: number | null
  /** Matches found, then dropped for not meeting the detector conditions. */
  condition_filtered_matches: number
  /** One line per condition that was required. */
  conditions_applied: string[]
  sample_size_warning: string | null
  same_bar_ambiguity_count: number
  equity_curve: EquityPoint[]
  assumptions: string[]
  data_quality: string[]
}

export interface BacktestResult {
  id: string
  created_at: number
  status: string
  primary_symbol: string
  symbols: string[]
  interval: Interval
  selection: { start_time: number; end_time: number }
  provider: string
  configuration: BacktestRequest
  summary: BacktestSummary | null
  matches: PatternMatch[]
  trades: Trade[]
  error_message: string | null
}

export interface BacktestListItem {
  id: string
  created_at: number
  primary_symbol: string
  interval: Interval
  status: string
  trades_executed: number | null
  win_rate: number | null
  net_return: number | null
}

export const DEFAULT_TRADE_RULES: TradeRules = {
  direction: 'long',
  entry_type: 'selection_close',
  stop_loss_type: 'percentage',
  stop_loss_value: 1,
  take_profit_type: 'risk_reward',
  take_profit_value: 2,
  maximum_holding_bars: 24,
  fee_percent: 0.02,
  slippage_percent: 0.01,
  allow_overlapping_trades: true,
  atr_period: 14,
}

/**
 * How much money stands behind a trade, and how much of it one trade may lose.
 *
 * Kept apart from `TradeRules` on purpose: the rules describe the *trade* and
 * are sent to the engine, which sizes nothing and answers in percentages.
 * These two numbers never leave the browser -- they only translate what the
 * engine already said into money.
 */
export interface SizingConfig {
  /** Account equity the risk percentage is taken from. */
  accountEquity: number
  /** Share of the account a single stop-out is allowed to cost. */
  riskPercent: number
}

export const DEFAULT_SIZING: SizingConfig = {
  accountEquity: 100_000,
  riskPercent: 1,
}

/** Risk sizes offered as one click, the range a risk-of-ruin table lives in. */
export const RISK_PRESETS = [0.25, 0.5, 1, 2] as const

export interface SearchConfig {
  lookbackDays: number
  maximumMatches: number
  minimumSimilarity: number
  patternLength: number | null
  searchSymbols: string[]
}

export const DEFAULT_SEARCH_CONFIG: SearchConfig = {
  lookbackDays: 180,
  maximumMatches: 25,
  /**
   * Similarity is a cosine over a multi-block, standardised feature vector,
   * not a raw price correlation, so real matches score lower than the number
   * suggests. Measured against six months of hourly index futures, 0.75
   * returns nothing at all while 0.6 fills the match list; a default that
   * always yields an empty result is worse than one that yields a few weak
   * matches the user can tighten.
   */
  minimumSimilarity: 0.6,
  patternLength: null,
  searchSymbols: ['ES', 'NQ', 'YM'],
}

/** Everything needed to turn a selection plus form state into a request. */
export interface BacktestFormState {
  selection: SelectionRange | null
  rules: TradeRules
  search: SearchConfig
  detectors: DetectorFilters
  learning: LearningSettings
}
