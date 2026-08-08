/** ICT analysis types. Mirrors the backend schemas in app/models/schemas.py. */

import type { Interval } from '@/types/market'

export type SwingKind = 'high' | 'low'
export type GapDirection = 'bullish' | 'bearish'
export type SmtBias = 'bearish' | 'bullish'
export type SmtValidity = 'swing_pair' | 'fvg_edge' | 'unconfirmed'

export interface SwingPoint {
  symbol: string
  kind: SwingKind
  time: number
  price: number
  /**
   * The bar at which this pivot became knowable. A swing point needs
   * `strength` bars to its right before it is confirmed, so anything acting on
   * a swing must use this, not `time`.
   */
  confirmed_time: number
  strength: number
}

export interface FairValueGap {
  symbol: string
  direction: GapDirection
  time: number
  start_time: number
  end_time: number
  bottom: number
  top: number
  midpoint: number
  size: number
  size_percent: number
  mitigated: boolean
  mitigated_time: number | null
  filled: boolean
  filled_time: number | null
  /** 0 = untouched, 1 = fully filled. */
  penetration: number
}

export interface SmtDivergence {
  kind: SwingKind
  bias: SmtBias
  primary_symbol: string
  reference_symbol: string
  start_time: number
  end_time: number
  primary_start_price: number
  primary_end_price: number
  reference_start_price: number
  reference_end_price: number
  leading_symbol: string
  lagging_symbol: string
  validity: SmtValidity
  valid: boolean
  confirmed_time: number
  inside_fair_value_gap: boolean
  fair_value_gap_time: number | null
  strength: number
  separation_bars: number
}

export interface IctAnalysis {
  symbol: string
  interval: Interval
  from_time: number
  to_time: number
  provider: string
  bars_analysed: number
  swing_strength: number
  reference_symbols: string[]
  swing_points: SwingPoint[]
  fair_value_gaps: FairValueGap[]
  smt_divergences: SmtDivergence[]
  warnings: string[]
}

export const VALIDITY_LABELS: Record<SmtValidity, string> = {
  swing_pair: 'Swing pair',
  fvg_edge: 'Gap edge',
  unconfirmed: 'Unconfirmed',
}

export const VALIDITY_NOTES: Record<SmtValidity, string> = {
  swing_pair: 'Both anchors are swing points on the reference chart. Strongest case.',
  fvg_edge:
    'An anchor is not a swing point but sits on the high or low of a fair value gap, ' +
    'which the rules still accept.',
  unconfirmed:
    'Neither anchor is a swing point or a gap edge. Shown for inspection only.',
}

/** What the detectors should look for. Sent as query parameters. */
export interface IctSettings {
  enabled: boolean
  swingStrength: number
  minGapPercent: number
  includeFilledGaps: boolean
  includeInvalidSmt: boolean
  showSwings: boolean
  showGaps: boolean
  showSmt: boolean
}

export const DEFAULT_ICT_SETTINGS: IctSettings = {
  enabled: true,
  swingStrength: 2,
  minGapPercent: 0.05,
  includeFilledGaps: false,
  includeInvalidSmt: false,
  showSwings: true,
  showGaps: true,
  showSmt: true,
}
