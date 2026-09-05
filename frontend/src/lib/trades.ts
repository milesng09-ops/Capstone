/**
 * Simulated trades, as things to draw and things to explain.
 *
 * A row in a table says a trade won. It does not say *where* it was, how long
 * it was held, how close it came to the stop, or what the engine thought it
 * was looking at when it took the entry. Those are questions about the chart,
 * so this module turns a trade back into chart objects: a position box in
 * market coordinates, and the detections that were live behind it.
 *
 * Everything here is pure and works in market units -- times in Unix
 * milliseconds, prices as prices. Pixels belong to the overlay.
 */

import type { PatternMatch, Trade } from '@/types/backtest'
import type { FairValueGap, IctAnalysis, SmtDivergence, SwingPoint } from '@/types/ict'
import type { TimeWindow } from '@/types/market'

/**
 * A trade as the long/short position tool that traders mark up by hand: entry
 * in the middle, the risk below it and the reward above (inverted for a
 * short), running from entry to exit.
 */
export interface PositionBox {
  id: string
  tradeNumber: number
  symbol: string
  isLong: boolean
  /** Entry and exit times, in Unix milliseconds. */
  from: number
  to: number
  entry: number
  stop: number
  target: number
  exit: number
  netReturn: number
  won: boolean
}

export function positionBox(trade: Trade): PositionBox {
  return {
    id: trade.id,
    tradeNumber: trade.trade_number,
    symbol: trade.symbol,
    isLong: trade.direction === 'long',
    // A trade that exits on its entry bar would otherwise be a zero-width
    // box, i.e. invisible. The overlay widens it to a minimum on screen; the
    // times stay honest here.
    from: Math.min(trade.entry_time, trade.exit_time),
    to: Math.max(trade.entry_time, trade.exit_time),
    entry: trade.entry_price,
    stop: trade.stop_price,
    target: trade.target_price,
    exit: trade.exit_price,
    netReturn: trade.net_return,
    won: trade.net_return > 0,
  }
}

/** The trades taken on one instrument. Trades are searched across several. */
export function tradesForSymbol(trades: Trade[], symbol: string): Trade[] {
  return trades.filter((trade) => trade.symbol === symbol)
}

export function findTrade(trades: Trade[], id: string | null): Trade | null {
  if (!id) return null
  return trades.find((trade) => trade.id === id) ?? null
}

/**
 * The stretch of history behind a trade.
 *
 * It starts at the matched pattern, not at the entry: the engine decided to
 * take this trade because those bars looked like the selected setup, so the
 * question "what was it looking at?" is answered by the window that runs from
 * the start of the match to the exit. Without the match -- an old run, a
 * trade whose match was pruned -- the trade's own span is the best available
 * answer.
 */
export function evidenceWindow(trade: Trade, match?: PatternMatch | null): TimeWindow {
  const start = match ? Math.min(match.start_time, trade.entry_time) : trade.entry_time
  return {
    start_time: start,
    end_time: Math.max(trade.exit_time, trade.entry_time),
  }
}

export function findMatch(matches: PatternMatch[], trade: Trade | null): PatternMatch | null {
  if (!trade) return null
  return matches.find((match) => match.id === trade.pattern_match_id) ?? null
}

/** The detections that were live over one window. */
export interface TradeEvidence {
  window: TimeWindow
  gaps: FairValueGap[]
  swings: SwingPoint[]
  divergences: SmtDivergence[]
}

export const EMPTY_EVIDENCE: TradeEvidence = {
  window: { start_time: 0, end_time: 0 },
  gaps: [],
  swings: [],
  divergences: [],
}

/**
 * True while a gap is still standing at `time`.
 *
 * An unfilled gap has no right edge: price never traded back through it, so
 * it remains a level indefinitely and is live at any later moment. A filled
 * one stops at the bar that filled it.
 */
function gapLiveUntil(gap: FairValueGap): number {
  if (!gap.filled) return Number.POSITIVE_INFINITY
  return gap.filled_time ?? gap.end_time
}

/**
 * Everything the detectors found inside a window.
 *
 * Swings are filtered on `confirmed_time` as well as `time`: a pivot that had
 * not yet formed when the trade was taken was not evidence for anything, and
 * showing it would suggest the engine acted on information it did not have.
 */
export function collectEvidence(
  analysis: IctAnalysis | undefined,
  window: TimeWindow,
): TradeEvidence {
  if (!analysis) return { ...EMPTY_EVIDENCE, window }

  const { start_time: from, end_time: to } = window

  const gaps = analysis.fair_value_gaps.filter(
    (gap) => gap.start_time <= to && gapLiveUntil(gap) >= from,
  )

  const swings = analysis.swing_points.filter(
    (point: SwingPoint) => point.time >= from && point.time <= to && point.confirmed_time <= to,
  )

  const divergences = analysis.smt_divergences.filter(
    (divergence: SmtDivergence) => divergence.end_time >= from && divergence.start_time <= to,
  )

  return { window, gaps, swings, divergences }
}

export function hasEvidence(evidence: TradeEvidence): boolean {
  return (
    evidence.gaps.length > 0 ||
    evidence.swings.length > 0 ||
    evidence.divergences.length > 0
  )
}

/** A position box reduced to screen coordinates, for hit-testing. */
export interface ProjectedPosition {
  id: string
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * The topmost position box under the pointer.
 *
 * Later trades sit on top, so the search runs backwards -- the same rule the
 * drawings use, for the same reason: what you can see is what you can click.
 */
export function hitTestPositions(
  items: ProjectedPosition[],
  x: number,
  y: number,
): string | null {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (x >= item.left && x <= item.right && y >= item.top && y <= item.bottom) {
      return item.id
    }
  }
  return null
}

/** True when `time` falls inside the window, which is inclusive at both ends. */
export function withinWindow(window: TimeWindow | null, time: number): boolean {
  if (!window) return true
  return time >= window.start_time && time <= window.end_time
}
