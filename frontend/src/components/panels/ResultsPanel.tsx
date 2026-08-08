/**
 * What the backtest found.
 *
 * Win rate leads, because that is the number the whole exercise exists to
 * produce -- the alternative being months of manual bar-by-bar replay. It is
 * deliberately shown next to the sample size and the modelling assumptions:
 * a 70% win rate over six trades is not a finding, and the panel should not
 * let it look like one.
 */

import { useState } from 'react'
import { Info, TriangleAlert } from 'lucide-react'

import { EquityCurve } from '@/components/panels/EquityCurve'
import { TradesTable } from '@/components/panels/TradesTable'
import { Badge, EmptyState, Metric, Spinner } from '@/components/ui/primitives'
import { SegmentedControl } from '@/components/ui/fields'
import { useBacktestResult } from '@/hooks/useBacktest'
import { useWorkspace } from '@/store/workspace'
import type { BacktestResult } from '@/types/backtest'
import { cn } from '@/utils/cn'
import {
  directionClass,
  formatDateTime,
  formatInteger,
  formatNumber,
  formatPercent,
  formatRatio,
} from '@/utils/format'

type ResultTab = 'equity' | 'trades' | 'matches' | 'notes'

const TABS: { value: ResultTab; label: string }[] = [
  { value: 'equity', label: 'Equity' },
  { value: 'trades', label: 'Trades' },
  { value: 'matches', label: 'Matches' },
  { value: 'notes', label: 'Notes' },
]

export function ResultsPanel() {
  const activeId = useWorkspace((state) => state.activeBacktestId)
  const query = useBacktestResult(activeId)
  const [tab, setTab] = useState<ResultTab>('equity')

  if (!activeId) {
    return (
      <EmptyState
        title="No results yet"
        description="Select a setup on the chart, set the stop and target, then run the backtest. The win rate and every simulated trade will appear here."
      />
    )
  }

  if (query.isLoading) {
    return (
      <div className="grid h-full place-items-center">
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <Spinner /> Loading results...
        </span>
      </div>
    )
  }

  if (query.isError || !query.data) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-xs text-bear">
        {(query.error as Error)?.message ?? 'That backtest could not be loaded.'}
      </div>
    )
  }

  const result = query.data
  const summary = result.summary

  if (!summary) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-xs text-bear">
        {result.error_message ?? 'This run produced no summary.'}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <span className="label-caps">Results</span>
        <Badge tone="accent">{result.primary_symbol}</Badge>
        <Badge>{result.interval}</Badge>
        <span className="numeric text-2xs text-muted-foreground">
          {formatDateTime(result.created_at)}
        </span>
        {result.provider === 'demo' && (
          <Badge tone="warn" title="Synthetic data. These results describe generated prices.">
            demo data
          </Badge>
        )}
        <SegmentedControl<ResultTab>
          value={tab}
          options={TABS}
          onChange={setTab}
          className="ml-auto"
        />
      </header>

      <Headline summary={summary} />

      {summary.sample_size_warning && (
        <p className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-2xs leading-relaxed text-amber-300">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {summary.sample_size_warning}
        </p>
      )}

      <div className="min-h-0 flex-1 px-3 pb-3">
        {tab === 'equity' && <EquityCurve points={summary.equity_curve} />}
        {tab === 'trades' && <TradesTable trades={result.trades} />}
        {tab === 'matches' && <MatchesList result={result} />}
        {tab === 'notes' && <Notes summary={summary} />}
      </div>
    </div>
  )
}

function Headline({ summary }: { summary: NonNullable<BacktestResult['summary']> }) {
  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-4 xl:grid-cols-7">
      <div className="col-span-2 rounded-md border border-primary/30 bg-primary/10 p-2.5 sm:col-span-1">
        <p className="label-caps">Win rate</p>
        <p className="numeric mt-0.5 text-2xl font-semibold leading-none">
          {formatNumber(summary.win_rate, 1)}%
        </p>
        <p className="mt-1 text-2xs text-muted-foreground">
          {formatInteger(summary.wins)}W / {formatInteger(summary.losses)}L
          {summary.breakeven > 0 && ` / ${formatInteger(summary.breakeven)}F`}
        </p>
      </div>

      <Metric
        label="Trades"
        value={formatInteger(summary.trades_executed)}
        hint={`${summary.total_matches} matches found, ${summary.skipped_matches} skipped`}
      />
      <Metric
        label="Net return"
        value={formatPercent(summary.net_return)}
        tone={directionClass(summary.net_return)}
        hint="Sum of every trade's return after fees and slippage"
      />
      <Metric
        label="Expectancy"
        value={formatPercent(summary.expectancy)}
        tone={directionClass(summary.expectancy)}
        hint="Average return per trade"
      />
      <Metric
        label="Profit factor"
        value={formatRatio(summary.profit_factor)}
        hint="Gross winnings divided by gross losses. Above 1 is profitable."
      />
      <Metric
        label="Max drawdown"
        value={formatPercent(-Math.abs(summary.maximum_drawdown), 2, false)}
        tone="text-bear"
        hint="Largest peak-to-trough fall in the equity curve"
      />
      <Metric
        label="Achieved R:R"
        value={formatRatio(summary.risk_reward_achieved)}
        hint="Average winner divided by average loser"
      />
    </div>
  )
}

function MatchesList({ result }: { result: BacktestResult }) {
  if (result.matches.length === 0) {
    return (
      <div className="grid h-full place-items-center text-2xs text-muted-foreground">
        No historical windows matched the selected setup closely enough.
      </div>
    )
  }

  return (
    <div className="h-full overflow-auto">
      <ul className="space-y-1">
        {result.matches.map((match) => (
          <li
            key={match.id}
            className="flex items-center gap-2 rounded-md border border-border bg-[hsl(var(--panel-raised))] px-2 py-1.5 text-2xs"
          >
            <span className="numeric w-6 text-muted-foreground">#{match.rank}</span>
            <Badge>{match.symbol}</Badge>
            <span className="numeric text-muted-foreground">
              {formatDateTime(match.start_time)}
            </span>
            <span
              className="numeric ml-auto"
              title="Cosine similarity to the selected pattern"
            >
              {match.similarity_score.toFixed(4)}
            </span>
            <span
              className={cn(
                'numeric w-16 text-right',
                match.net_return == null ? 'text-muted-foreground' : directionClass(match.net_return),
              )}
            >
              {match.net_return == null ? 'not traded' : formatPercent(match.net_return)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Notes({ summary }: { summary: NonNullable<BacktestResult['summary']> }) {
  return (
    <div className="h-full space-y-3 overflow-auto pr-1">
      <Section title="How the trades were modelled" items={summary.assumptions} />
      <Section title="Data" items={summary.data_quality} />

      {summary.same_bar_ambiguity_count > 0 && (
        <p className="flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-2xs leading-relaxed text-amber-300">
          <Info size={12} className="mt-0.5 shrink-0" />
          {summary.same_bar_ambiguity_count} trade
          {summary.same_bar_ambiguity_count === 1 ? '' : 's'} had a candle that touched both
          the stop and the target. Without lower-timeframe data the order is unknowable, so
          the stop was assumed to trigger first. The true win rate is at least this high.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Metric label="Average winner" value={formatPercent(summary.average_winner)} tone="text-bull" />
        <Metric label="Average loser" value={formatPercent(summary.average_loser)} tone="text-bear" />
        <Metric label="Median return" value={formatPercent(summary.median_return)} />
        <Metric
          label="Average hold"
          value={`${formatNumber(summary.average_holding_bars, 1)} bars`}
        />
        <Metric label="Best streak" value={`${summary.longest_winning_streak} wins`} />
        <Metric label="Worst streak" value={`${summary.longest_losing_streak} losses`} />
        <Metric label="Timeouts" value={formatInteger(summary.timeouts)} />
        <Metric label="Gross return" value={formatPercent(summary.gross_return)} />
      </div>
    </div>
  )
}

function Section({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null
  return (
    <section>
      <p className="label-caps mb-1">{title}</p>
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item} className="flex gap-1.5 text-2xs leading-relaxed text-muted-foreground">
            <span className="text-border">&bull;</span>
            {item}
          </li>
        ))}
      </ul>
    </section>
  )
}
