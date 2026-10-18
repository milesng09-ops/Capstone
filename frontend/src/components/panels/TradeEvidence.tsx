/**
 * Why the engine took this trade.
 *
 * Miles's test of whether the app is worth trusting: "there could be an option
 * where you can see what the backend was trying to do -- to see if it
 * implemented the strategy correctly." A win rate you cannot audit is a number
 * to believe or disbelieve, not a result.
 *
 * So this states the trade in the order it happened -- the window that matched
 * the setup, what the detectors had standing there at the time, the prices the
 * rules put the stop and target at, and how it ended -- and the chart draws the
 * same evidence over the candles it came from.
 */

import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

import { Badge } from '@/components/ui/primitives'
import { useBacktestResult } from '@/hooks/useBacktest'
import { useIct } from '@/hooks/useMarketData'
import { collectEvidence, evidenceWindow, hasEvidence } from '@/lib/trades'
import {
  useChartedSymbols,
  useSymbolInterval,
  useTimeZone,
  useWorkspace,
} from '@/store/workspace'
import {
  EXIT_REASON_LABELS,
  type BacktestResult,
  type PatternMatch,
  type Trade,
  type TradeRules,
} from '@/types/backtest'
import { VALIDITY_LABELS, type IctSettings } from '@/types/ict'
import {
  INTERVAL_LABELS,
  INTERVAL_MS,
  MAX_RANGE_DAYS,
  type Interval,
  type SymbolKey,
  type TimeWindow,
} from '@/types/market'
import { cn } from '@/utils/cn'
import { directionClass, formatDateTime, formatPercent, formatPrice } from '@/utils/format'

/** Detections listed individually before the list is summarised instead. */
const MAX_ITEMS = 4

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/**
 * Bars read ahead of the window when the run recorded no search window: enough
 * for the pivots and shelves standing at the time to have formed in view.
 */
const LEAD_BARS = 500

/**
 * The detector settings the engine traded with, in the analysis request's
 * terms -- see `BacktestService._detector_context`: swings at the run's own
 * strength, gaps of any size with the filled ones kept, invalid divergences
 * dropped, and every shelf, swept or standing. A run stored without its
 * configuration leaves only the chart's settings to go on.
 */
function engineSettings(
  run: BacktestResult | undefined,
  chart: IctSettings,
): IctSettings {
  const detectors = run?.configuration?.detectors
  if (!detectors) return chart
  return {
    ...chart,
    swingStrength: detectors.swing_strength,
    minGapPercent: 0,
    includeFilledGaps: true,
    includeInvalidSmt: false,
    liquidityTolerancePercent: detectors.liquidity_tolerance_percent,
    liquidityMinTouches: detectors.liquidity_min_touches,
    includeSweptPools: true,
  }
}

/**
 * The market the engine measured this one against for SMT: the primary
 * against the first other series it searched, every other series against the
 * primary. Without the run, the charted markets are the best guess there is.
 */
function engineReferences(
  trade: Trade,
  run: BacktestResult | undefined,
  charted: string[],
): string[] {
  if (!run) return charted.filter((symbol) => symbol !== trade.symbol)
  if (trade.symbol !== run.primary_symbol) return [run.primary_symbol]
  const searched = run.configuration?.symbols ?? run.symbols
  const other = searched.find((symbol) => symbol !== run.primary_symbol)
  return other ? [other] : []
}

/**
 * History that covers the trade, whatever the chart happens to have loaded.
 *
 * From the start of the run's own search window when it recorded one -- that
 * is what the engine read its pivots and shelves from -- otherwise a lead of
 * bars ahead of the window. It ends just past *this trade's* exit rather than
 * at the end of the run: the detections endpoint returns only the most recent
 * few hundred of each kind, so a request running to the end of a long run kept
 * the latest ones and dropped an early trade's entirely, which then read as
 * "nothing was detected". Ending here makes this trade's stretch the most
 * recent. It never asks for more than one request can carry. Snapped to the
 * hour, as the chart's own window is.
 */
function evidenceRange(
  window: TimeWindow,
  interval: Interval,
  run: BacktestResult | undefined,
): { from: number; to: number } {
  const bar = INTERVAL_MS[interval]
  const cap = MAX_RANGE_DAYS[interval] * DAY_MS
  const search = run?.configuration?.search

  let from = search
    ? Math.min(search.lookback_start, window.start_time)
    : window.start_time - LEAD_BARS * bar
  const to = window.end_time + bar
  if (to - from > cap) from = to - cap

  return {
    from: Math.floor(from / HOUR_MS) * HOUR_MS,
    to: Math.ceil(to / HOUR_MS) * HOUR_MS,
  }
}

export function TradeEvidence({
  trade,
  match,
  rules,
}: {
  trade: Trade
  match: PatternMatch | null
  rules: TradeRules
}) {
  // Timestamps below are drawn in the zone chosen in the status bar;
  // reading it here is what re-renders them when that changes.
  useTimeZone()

  const settings = useWorkspace((state) => state.ict)
  const activeId = useWorkspace((state) => state.activeBacktestId)
  const charted = useChartedSymbols()
  // The pane the trade's market is drawn on, for a run that does not say.
  const paneInterval = useSymbolInterval(trade.symbol as SymbolKey)

  /*
   * Read from the run, not from the chart.
   *
   * This used to ask for the chart's own analysis -- the interval on screen,
   * the history currently loaded, the Analysis panel's settings. So a 1h trade
   * was explained with 15m detections once the chart moved to 15m, and a trade
   * older than the loaded history, or a request that failed, left nothing to
   * list: the panel then said "Nothing was detected over these bars" when no
   * bars had been looked at. The run is the one the results panel is showing,
   * cached by id, so reading it here costs no request.
   */
  const fetched = useBacktestResult(activeId).data
  const run = fetched?.trades.some((item) => item.id === trade.id) ? fetched : undefined
  const interval = run?.interval ?? paneInterval

  const window = evidenceWindow(trade, match)
  const range = evidenceRange(window, interval, run)
  const query = useIct(
    trade.symbol,
    interval,
    range.from,
    range.to,
    engineReferences(trade, run, charted),
    engineSettings(run, settings),
  )

  // Another trade's analysis, kept on screen while this one's loads, is not
  // evidence about this one.
  const analysis = query.isPlaceholderData ? undefined : query.data
  const evidence = collectEvidence(analysis, window)
  const long = trade.direction === 'long'
  const Arrow = long ? ArrowUpRight : ArrowDownRight

  return (
    <div className="space-y-2 rounded-md border border-primary/30 bg-primary/5 p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">
          <Arrow size={10} />
          #{trade.trade_number} {long ? 'Long' : 'Short'} {trade.symbol}
        </Badge>
        <span className={cn('numeric text-2xs font-medium', directionClass(trade.net_return))}>
          {formatPercent(trade.net_return)}
        </span>
        <span className="text-2xs text-muted-foreground">
          {EXIT_REASON_LABELS[trade.exit_reason] ?? trade.exit_reason} after{' '}
          {trade.holding_bars} bars
        </span>
      </div>

      <ol className="space-y-1 text-2xs leading-relaxed text-muted-foreground">
        <Step index={1} title="Matched the setup">
          {match ? (
            <>
              {formatDateTime(match.start_time)} &rarr; {formatDateTime(match.end_time)}, at{' '}
              <span className="numeric">{match.similarity_score.toFixed(3)}</span> similarity
              to the selected pattern.
            </>
          ) : (
            <>
              The matched window was not stored with this run, so the evidence below covers
              the trade itself.
            </>
          )}
        </Step>

        <Step index={2} title="Detectors standing here">
          {/*
            Said only of the timeframe the run was tested on: a chart since
            moved to another interval shows other detections over the same
            stretch, and the difference would otherwise look like an error.
          */}
          {run && interval !== paneInterval && (
            <>Read on the {INTERVAL_LABELS[interval]} bars the run was tested on. </>
          )}
          {/*
            "Nothing was detected" is a finding, so it is only ever said of bars
            that were actually analysed. Switched off, failed, still loading or
            empty, the panel says which -- each is an answer about this app,
            not about the market.
          */}
          {!settings.enabled ? (
            'Detectors are switched off under Analysis, so these bars have not been analysed.'
          ) : query.isError ? (
            `The analysis for these bars could not be loaded (${
              (query.error as Error).message
            }), so what was standing here is not known.`
          ) : query.isLoading || !analysis ? (
            'Loading the analysis for this window...'
          ) : analysis.bars_analysed === 0 ? (
            'No candles were available for these bars, so what was standing here is not known.'
          ) : hasEvidence(evidence) ? (
            <>
              <span className="flex flex-wrap gap-1 py-0.5">
                {evidence.gaps.length > 0 && (
                  <Badge>
                    {evidence.gaps.length} fair value gap
                    {evidence.gaps.length === 1 ? '' : 's'}
                  </Badge>
                )}
                {evidence.swings.length > 0 && (
                  <Badge>
                    {evidence.swings.length} swing point
                    {evidence.swings.length === 1 ? '' : 's'}
                  </Badge>
                )}
                {evidence.divergences.length > 0 && (
                  <Badge tone="warn">
                    {evidence.divergences.length} SMT divergence
                    {evidence.divergences.length === 1 ? '' : 's'}
                  </Badge>
                )}
                {evidence.pools.length > 0 && (
                  <Badge>
                    {evidence.pools.length} liquidity pool
                    {evidence.pools.length === 1 ? '' : 's'}
                  </Badge>
                )}
              </span>
              <ul className="space-y-0.5 pt-0.5">
                {evidence.gaps.slice(0, MAX_ITEMS).map((gap) => (
                  <li key={`gap-${gap.time}`}>
                    &bull; {gap.direction} gap {formatPrice(gap.bottom)}&ndash;
                    {formatPrice(gap.top)}
                    {gap.filled
                      ? ', filled'
                      : gap.mitigated
                        ? `, tapped ${(gap.penetration * 100).toFixed(0)}% in`
                        : ', untouched'}
                  </li>
                ))}
                {evidence.divergences.slice(0, MAX_ITEMS).map((divergence) => (
                  <li key={`smt-${divergence.start_time}-${divergence.end_time}`}>
                    &bull; {divergence.bias} SMT at a {divergence.kind},{' '}
                    {divergence.leading_symbol} led {divergence.lagging_symbol} (
                    {VALIDITY_LABELS[divergence.validity].toLowerCase()})
                  </li>
                ))}
                {/*
                  Swept or standing is the whole reading of a shelf: the one
                  behind the trade is why it was taken, the one in front is
                  where it was going.
                */}
                {evidence.pools.slice(0, MAX_ITEMS).map((pool) => (
                  <li key={`pool-${pool.kind}-${pool.price}-${pool.formed_time}`}>
                    &bull; {pool.touch_count} equal {pool.kind}s at{' '}
                    {formatPrice(pool.price)}
                    {pool.swept ? ', swept' : ', still standing'}
                  </li>
                ))}
              </ul>
            </>
          ) : analysis.warnings.some((note) => /most recent/i.test(note)) ? (
            // Trimmed to the newest detections, so an empty window is not a
            // finding: what stood here may simply not have come back.
            <>
              The analysis came back trimmed to its most recent detections and none of them
              falls in this window, so what was standing here is not known.
            </>
          ) : (
            <>
              Nothing was detected over these bars. The trade was taken on the shape of the
              pattern alone, which is what the search matches on.
            </>
          )}
        </Step>

        <Step index={3} title="Rules applied">
          Entered at {entryPhrase(rules)} &mdash;{' '}
          <span className="numeric">{formatPrice(trade.entry_price)}</span>. Stop{' '}
          {stopPhrase(rules)} at{' '}
          <span className="numeric">{formatPrice(trade.stop_price)}</span>, target{' '}
          {targetPhrase(rules)} at{' '}
          <span className="numeric">{formatPrice(trade.target_price)}</span>.
        </Step>

        <Step index={4} title="Outcome">
          Closed at <span className="numeric">{formatPrice(trade.exit_price)}</span> on{' '}
          {formatDateTime(trade.exit_time)}.
          {trade.same_bar_ambiguity && (
            <span className="text-amber-400">
              {' '}
              One candle touched both the stop and the target; without lower-timeframe data
              the stop is assumed to have triggered first.
            </span>
          )}
        </Step>
      </ol>
    </div>
  )
}

function Step({
  index,
  title,
  children,
}: {
  index: number
  title: string
  children: React.ReactNode
}) {
  return (
    <li className="flex gap-2">
      <span className="numeric shrink-0 text-border">{index}</span>
      <span>
        <span className="font-medium text-foreground">{title}. </span>
        {children}
      </span>
    </li>
  )
}

function entryPhrase(rules: TradeRules): string {
  return rules.entry_type === 'next_open'
    ? 'the open of the bar after the match'
    : 'the close of the matched pattern'
}

function stopPhrase(rules: TradeRules): string {
  switch (rules.stop_loss_type) {
    case 'percentage':
      return `${rules.stop_loss_value}% from entry`
    case 'atr_multiple':
      return `${rules.stop_loss_value}x ATR(${rules.atr_period})`
    case 'pattern_extreme':
      return 'at the high or low of the pattern'
    default:
      return 'at a fixed price'
  }
}

function targetPhrase(rules: TradeRules): string {
  switch (rules.take_profit_type) {
    case 'risk_reward':
      return `${rules.take_profit_value}x the stop distance`
    case 'liquidity':
      return `at the nearest standing liquidity pool offering at least ${rules.take_profit_value}R`
    case 'percentage':
      return `${rules.take_profit_value}% from entry`
    default:
      return 'at a fixed price'
  }
}
