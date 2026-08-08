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

export interface BacktestRequest {
  symbols: string[]
  primary_symbol: string
  interval: Interval
  selection: { start_time: number; end_time: number }
  trade: TradeRules
  search: SearchSettings
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
  profit_factor: number
  expectancy: number
  maximum_drawdown: number
  longest_winning_streak: number
  longest_losing_streak: number
  average_holding_bars: number
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
}
