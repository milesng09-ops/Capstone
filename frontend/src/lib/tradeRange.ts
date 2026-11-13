import type { PatternMatch, Trade } from '@/types/backtest'
import { INTERVAL_MS, MAX_RANGE_DAYS, type Interval } from '@/types/market'

/** Load the actual historical trade, even when it predates the live chart. */
export function tradeChartRange(trade: Trade, match: PatternMatch | null, interval: Interval) {
  const padding = 8 * INTERVAL_MS[interval]
  const limit = MAX_RANGE_DAYS[interval] * 86_400_000
  const from = Math.max(0, Math.min(match?.start_time ?? trade.entry_time, trade.entry_time) - padding)
  return { from, to: Math.min(from + limit, trade.exit_time + padding) }
}
