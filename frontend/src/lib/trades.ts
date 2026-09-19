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

import type { EquityPoint, PatternMatch, Trade } from '@/types/backtest'
import type {
  FairValueGap,
  IctAnalysis,
  LiquidityPool,
  SmtDivergence,
  SwingPoint,
} from '@/types/ict'
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
  pools: LiquidityPool[]
}

export const EMPTY_EVIDENCE: TradeEvidence = {
  window: { start_time: 0, end_time: 0 },
  gaps: [],
  swings: [],
  divergences: [],
  pools: [],
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

  /*
   * Shelves that had formed by the end of the window.
   *
   * Gated on `formed_time`, not on where the pivots sit: a shelf built long
   * before the trade is exactly the evidence wanted -- it is the level the
   * trade was taken against -- so filtering it to the window would hide the
   * reason. What must not appear is a shelf that became knowable afterwards,
   * which would suggest the engine acted on something it could not see.
   *
   * Both jobs are shown, because a liquidity trade has two: the shelf behind
   * it that was swept, and the shelf in front of it that was the target.
   */
  const pools = analysis.liquidity_pools.filter(
    (pool: LiquidityPool) =>
      pool.formed_time <= to && (!pool.swept || (pool.swept_time ?? 0) >= from),
  )

  return { window, gaps, swings, divergences, pools }
}

export function hasEvidence(evidence: TradeEvidence): boolean {
  return (
    evidence.gaps.length > 0 ||
    evidence.swings.length > 0 ||
    evidence.divergences.length > 0 ||
    evidence.pools.length > 0
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

/**
 * Where the backend's equity curve starts.
 *
 * `EquityPoint.equity` is an equity *level*, compounded from a notional 100 --
 * so a run that made 0.35% ends at 100.35, not at 0.35. The backend derives
 * `net_return` by subtracting this exact constant, which is what fixes the
 * unit; mirroring it here is the other half of that contract.
 */
export const STARTING_EQUITY = 100

/**
 * The curve as a cumulative return, which is what the chart draws.
 *
 * Without this the level was plotted against a percentage axis: the line
 * leapt from 0 to ~100 on the first trade and then looked flat for the rest
 * of the run, and the tooltip read "+100.35%" for a run that made a third of
 * a percent. Converting on the way in rather than changing the wire format
 * means runs already saved under the old convention read correctly too.
 */
export function cumulativeReturns(points: EquityPoint[]): EquityPoint[] {
  return points.map((point) => ({ ...point, equity: point.equity - STARTING_EQUITY }))
}
