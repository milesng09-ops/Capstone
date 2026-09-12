/**
 * What the backtest found.
 *
 * Win rate leads, because that is the number the whole exercise exists to
 * produce -- the alternative being months of manual bar-by-bar replay. It is
 * deliberately shown next to the sample size and the modelling assumptions:
 * a 70% win rate over six trades is not a finding, and the panel should not
 * let it look like one.
 */

import { useEffect, useState } from 'react'
import { Info, TriangleAlert } from 'lucide-react'

import { EquityCurve } from '@/components/panels/EquityCurve'
import { TradeEvidence } from '@/components/panels/TradeEvidence'
import { TradesTable } from '@/components/panels/TradesTable'
import { Badge, EmptyState, Metric, Spinner } from '@/components/ui/primitives'
import { SegmentedControl } from '@/components/ui/fields'
import { useBacktestResult } from '@/hooks/useBacktest'
import { findMatch, findTrade } from '@/lib/trades'
import { useTimeZone, useWorkspace } from '@/store/workspace'
import type { BacktestResult, LearnedWeightsSummary } from '@/types/backtest'
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
  // Timestamps below are drawn in the zone chosen in the status bar;
  // reading it here is what re-renders them when that changes.
  useTimeZone()

  const activeId = useWorkspace((state) => state.activeBacktestId)
  const selectedTradeId = useWorkspace((state) => state.selectedTradeId)
  const selectTrade = useWorkspace((state) => state.selectTrade)
  const query = useBacktestResult(activeId)
  // Trades lead: they are the trades a run produced, and the row and the
  // position box on the chart are two views of the same thing.
  const [tab, setTab] = useState<ResultTab>('trades')

  // Picking a trade off the chart should not leave the panel showing a
  // different tab than the thing that was just selected.
  useEffect(() => {
    if (selectedTradeId) setTab('trades')
  }, [selectedTradeId])

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
  const selectedTrade = findTrade(result.trades, selectedTradeId)

  if (!summary) {
    return (
      <div className="grid h-full place-items-center p-4 text-center text-xs text-bear">
        {result.error_message ?? 'This run produced no summary.'}
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border py-1.5 pl-3 pr-9">
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
          variant="plain"
          value={tab}
          options={TABS}
          onChange={setTab}
          className="ml-auto"
        />
      </header>

      <Headline summary={summary} />

      {summary.learned_weights && <FittedWeights fit={summary.learned_weights} />}

      {summary.sample_size_warning && (
        <p className="mx-3 mb-2 flex items-start gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-2xs leading-relaxed text-amber-300">
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
          {summary.sample_size_warning}
        </p>
      )}

      <div className="flex min-h-0 flex-1 flex-col gap-2 px-3 pb-3">
        {tab === 'equity' && <EquityCurve points={summary.equity_curve} />}
        {tab === 'trades' && (
          <>
            {/*
             * Capped and scrollable: the evidence for a trade is several
             * paragraphs, and in a short results pane it otherwise pushed
             * the table out of the panel and over the status bar.
             */}
            {selectedTrade && (
              <div className="max-h-[45%] shrink-0 overflow-y-auto">
                <TradeEvidence
                  trade={selectedTrade}
                  match={findMatch(result.matches, selectedTrade)}
                  rules={result.configuration.trade}
                />
              </div>
            )}
            <div className="min-h-0 flex-1">
              <TradesTable
                trades={result.trades}
                selectedId={selectedTradeId}
                onSelect={selectTrade}
              />
            </div>
          </>
        )}
        {tab === 'matches' && <MatchesList result={result} />}
        {tab === 'notes' && <Notes summary={summary} />}
      </div>
    </div>
  )
}

function Headline({ summary }: { summary: NonNullable<BacktestResult['summary']> }) {
  // A run saved before the interval existed has no interval, and its stored
  // summary defaults both bounds to zero. Rendering that as "0-0% at 95%"
  // would state a certainty about an old result that was never computed, so
  // the band and its caption are simply left off.
  const hasInterval = summary.win_rate_high > summary.win_rate_low

  return (
    <div className="grid shrink-0 grid-cols-2 gap-2 p-3 sm:grid-cols-4 xl:grid-cols-8">
      <div className="col-span-2 rounded-md border border-primary/30 bg-primary/10 p-2.5">
        <p className="label-caps">Win rate</p>
        <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <p className="numeric text-2xl font-semibold leading-none">
            {formatNumber(summary.win_rate, 1)}%
          </p>
          {hasInterval && (
            <p className="numeric text-2xs text-muted-foreground">
              {formatNumber(summary.win_rate_low, 0)}&ndash;
              {formatNumber(summary.win_rate_high, 0)}% at 95%
            </p>
          )}
        </div>
        {hasInterval && (
          <ConfidenceBar
            low={summary.win_rate_low}
            high={summary.win_rate_high}
            point={summary.win_rate}
            baseline={summary.baseline?.win_rate ?? null}
            caption={baselineCaption(summary)}
          />
        )}
        <p className="mt-1 text-2xs text-muted-foreground">
          {formatInteger(summary.wins)}W / {formatInteger(summary.losses)}L
          {summary.breakeven > 0 && ` / ${formatInteger(summary.breakeven)}F`}
        </p>
      </div>

      <Metric
        label="Trades"
        value={formatInteger(summary.trades_executed)}
        hint={matchesHint(summary)}
      />
      <Metric
        label="Net return"
        value={formatPercent(summary.net_return)}
        tone={directionClass(summary.net_return)}
        hint="Every trade's return after fees and slippage, compounded"
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
        hint={
          summary.profit_factor == null
            ? 'Undefined: no trade lost, so there is nothing to divide by.'
            : 'Gross winnings divided by gross losses. Above 1 is profitable.'
        }
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

/**
 * The fitted weights, led by the only verdict that decides anything.
 *
 * A fit beating the hand-set numbers on its own training data is close to
 * guaranteed -- seven free parameters against a few dozen trades -- so
 * `improved` is deliberately not the headline. What matters is whether it
 * still wins on history it never saw, and when it does not, saying so plainly
 * is the entire reason the lookback is split.
 *
 * The weights themselves are printed in full because they are the whole
 * model. Seven numbers is small enough to read, and a model you can read is
 * one you can argue with.
 */
function FittedWeights({ fit }: { fit: LearnedWeightsSummary }) {
  const margin =
    fit.holdout_margin != null && fit.holdout_margin_stderr != null
      ? ` Margin ${formatNumber(fit.holdout_margin, 3)} per trade, give or take ${formatNumber(fit.holdout_margin_stderr, 3)}.`
      : ''

  const verdict =
    fit.holdout_verdict == null
      ? {
          tone: 'border-border bg-[hsl(var(--panel-raised))] text-muted-foreground',
          text: `Weights fitted on ${formatInteger(fit.labelled_windows)} earlier windows, asked from ${formatInteger(fit.query_windows)}. The out-of-sample half was too small to judge whether they hold up.`,
        }
      : fit.holdout_verdict === 'better'
        ? {
            tone: 'border-bull/30 bg-bull/10 text-bull',
            text: `Fitted weights beat the hand-set ones on ${formatInteger(fit.holdout_windows)} windows they were never shown, by more than the measurement's own noise.${margin}`,
          }
        : fit.holdout_verdict === 'worse'
          ? {
              tone: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
              text: `Fitted weights did worse than the hand-set ones on ${formatInteger(fit.holdout_windows)} windows they had never seen, by more than the noise. They scored ${formatNumber(fit.train_score, 3)} against ${formatNumber(fit.default_score, 3)} on the data they were fitted to; that gap is the fit learning noise.${margin}`,
            }
          : {
              /*
               * The case this whole banner was rebuilt for. A fit can be
               * ahead on the raw numbers and still be the same model with
               * noise on it -- 0.407 against 0.403 read as a clean win in
               * green, which is the overclaiming the rest of the app refuses.
               * Neutral, and it says why.
               */
              tone: 'border-border bg-[hsl(var(--panel-raised))] text-muted-foreground',
              text: `Fitted weights came out level with the hand-set ones on ${formatInteger(fit.holdout_windows)} windows they had never seen: the difference is smaller than its own error bar, so there is nothing to tell them apart.${margin}`,
            }

  return (
    <div className="mx-3 mb-2 flex flex-col gap-1.5">
      <p
        className={cn(
          'flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-2xs leading-relaxed',
          verdict.tone,
        )}
      >
        {fit.holdout_verdict === 'worse' ? (
          <TriangleAlert size={12} className="mt-0.5 shrink-0" />
        ) : (
          <Info size={12} className="mt-0.5 shrink-0" />
        )}
        {verdict.text}
      </p>
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 px-0.5 text-2xs text-muted-foreground">
        {/* The coarse model is three numbers; show those, since they are what
            was actually searched, and the seven below are their expansion. */}
        {Object.entries(fit.group_weights ?? {}).map(([name, value]) => (
          <span key={`group-${name}`} className="numeric font-medium text-foreground">
            {name} {formatNumber(value, 2)}
          </span>
        ))}
        {Object.entries(fit.weights).map(([name, value]) => (
          <span key={name} className="numeric">
            {name.replace(/_/g, ' ')}{' '}
            <span className={value === 0 ? 'text-bear' : 'text-foreground'}>
              {formatNumber(value, 2)}
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

/**
 * Where the matches went. A match dropped by a condition is not a failure to
 * simulate, so it is counted and named separately from a skip -- otherwise
 * "25 found, 22 skipped" reads as something going wrong.
 */
function matchesHint(summary: NonNullable<BacktestResult['summary']>): string {
  const parts = [`${summary.total_matches} matches found`]
  if (summary.condition_filtered_matches > 0) {
    parts.push(`${summary.condition_filtered_matches} failed the conditions`)
  }
  parts.push(`${summary.skipped_matches} skipped`)
  return parts.join(', ')
}

/**
 * The baseline in one line, under the band it is marked on.
 *
 * Two facts, in the order they should be read: what an arbitrary entry paid
 * under these same rules, and how often chance alone matches the result. The
 * second is phrased as odds rather than a p-value -- "1 in 3" is harder to
 * mistake for a small number than "0.36".
 *
 * Once more than one configuration has been tried on this window, the odds
 * quoted are the family-wise ones. Showing the single-test figure there would
 * be the tool's most flattering possible lie: every individual run looks
 * honest, and the twentieth 1-in-20 result is arithmetic rather than a
 * finding.
 */
function baselineCaption(
  summary: NonNullable<BacktestResult['summary']>,
): string | null {
  const baseline = summary.baseline
  if (!baseline) return null

  const head = `Random entry ${formatNumber(baseline.win_rate, 1)}%`
  const repeated = summary.configurations_tried > 1
  const p = repeated ? summary.family_wise_p_value : summary.baseline_p_value
  if (p == null) return head

  const odds =
    p < 0.001
      ? 'under 1 in 1,000'
      : `1 in ${formatInteger(Math.round(1 / p))}`
  const scope = repeated
    ? ` across ${formatInteger(summary.configurations_tried)} configurations tried here`
    : ''
  return `${head} · chance alone: ${odds}${scope}`
}

/**
 * The win rate as a span rather than a point, with the random-entry baseline
 * marked on the same scale. Seeing the two together is the whole argument:
 * a band that sits clear of the marker is a result, one that straddles it is
 * not, and the width says how much the sample can actually support.
 */
function ConfidenceBar({
  low,
  high,
  point,
  baseline,
  caption,
}: {
  low: number
  high: number
  point: number
  baseline: number | null
  caption: string | null
}) {
  const clamp = (value: number) => Math.max(0, Math.min(100, value))
  const left = clamp(low)
  const width = Math.max(clamp(high) - left, 0.5)

  return (
    <div
      className="mt-2"
      title={
        `95% of the time, the true win rate for this setup lies between ` +
        `${formatNumber(low, 0)}% and ${formatNumber(high, 0)}%.` +
        (baseline != null
          ? ` Random entry pays ${formatNumber(baseline, 1)}%.`
          : '')
      }
    >
      <div className="relative h-1.5 w-full rounded-sm bg-border">
        <div
          className="absolute inset-y-0 rounded-sm bg-primary/50"
          style={{ left: `${left}%`, width: `${width}%` }}
        />
        <div
          className="absolute -inset-y-0.5 w-0.5 rounded-sm bg-primary"
          style={{ left: `${clamp(point)}%` }}
        />
        {baseline != null && (
          <div
            className="absolute -inset-y-1 w-px bg-foreground"
            style={{ left: `${clamp(baseline)}%` }}
            aria-hidden
          />
        )}
      </div>
      {caption && <p className="mt-1 text-2xs text-muted-foreground">{caption}</p>}
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
        <Metric
          label="Gross return"
          value={formatPercent(summary.gross_return)}
          hint="Compounded the same way as net return, before fees"
        />
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
