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
import { useChartRange } from '@/hooks/useChartRange'
import { useIct } from '@/hooks/useMarketData'
import { collectEvidence, evidenceWindow, hasEvidence } from '@/lib/trades'
import { useChartedSymbols, useWorkspace } from '@/store/workspace'
import {
  EXIT_REASON_LABELS,
  type PatternMatch,
  type Trade,
  type TradeRules,
} from '@/types/backtest'
import { VALIDITY_LABELS } from '@/types/ict'
import { cn } from '@/utils/cn'
import { directionClass, formatDateTime, formatPercent, formatPrice } from '@/utils/format'

/** Detections listed individually before the list is summarised instead. */
const MAX_ITEMS = 4

export function TradeEvidence({
  trade,
  match,
  rules,
}: {
  trade: Trade
  match: PatternMatch | null
  rules: TradeRules
}) {
  const range = useChartRange()
  const interval = useWorkspace((state) => state.interval)
  const settings = useWorkspace((state) => state.ict)
  const charted = useChartedSymbols()

  // The same arguments the chart panel uses, so this is a cache hit rather
  // than a second trip to the server for analysis already on screen.
  const references = charted.filter((symbol) => symbol !== trade.symbol)
  const query = useIct(trade.symbol, interval, range.from, range.to, references, settings)

  const window = evidenceWindow(trade, match)
  const evidence = collectEvidence(query.data, window)
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
          {query.isLoading ? (
            'Loading the analysis for this window...'
          ) : !settings.enabled ? (
            'Detectors are switched off, so there is nothing recorded for this window.'
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
              </ul>
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
    case 'percentage':
      return `${rules.take_profit_value}% from entry`
    default:
      return 'at a fixed price'
  }
}
