/**
 * The selected setup, where to test it, the rules to trade it by, and the
 * button that runs it.
 *
 * The flow Miles described: mark the setup on the chart, say where the stop
 * and target go, and get a win rate back without sitting through months of
 * bar-by-bar replay. No buy and no sell button -- the engine takes the trades,
 * so the only verb here is *test*.
 *
 * The panel is ordered by how often each part is touched. The setup, the
 * window and the two prices that define risk change every run and are open.
 * Fees, slippage, the ATR period and the search thresholds are set once and
 * then left, so they are folded away: still one click from here, but no
 * longer between the user and the run button.
 */

import { useMemo } from 'react'
import { useIsMutating } from '@tanstack/react-query'
import { BoxSelect, CalendarRange, Play, RotateCcw, X } from 'lucide-react'

import { PositionSizing } from '@/components/panels/PositionSizing'
import { GxtStrategyPanel } from '@/components/panels/GxtStrategyPanel'
import { NumberField, SelectField, ToggleField } from '@/components/ui/fields'
import { Badge, Button, Disclosure, Spinner } from '@/components/ui/primitives'
import { StrategyStart } from '@/components/panels/StrategyStart'
import { useChartRange } from '@/hooks/useChartRange'
import { useBars } from '@/hooks/useMarketData'
import {
  buildBacktestRequest,
  effectiveLookbackDays,
  RUN_BACKTEST_MUTATION_KEY,
  searchedSymbols,
  useRunBacktest,
} from '@/hooks/useBacktest'
import {
  canReadBias,
  useChartedSymbols,
  useSymbolInterval,
  useTimeZone,
  useWorkspace,
} from '@/store/workspace'
import {
  SESSION_HOURS,
  SESSION_KEYS,
  SESSION_LABELS,
  type DetectorFilters,
  type LearningSettings,
  type Direction,
  type EntryType,
  type StopLossType,
  type TakeProfitType,
} from '@/types/backtest'
import {
  INTERVALS,
  INTERVAL_LABELS,
  MAX_RANGE_DAYS,
  validBiasInterval,
  type Interval,
} from '@/types/market'
import { indexOfBar } from '@/lib/chart'
import {
  formatCurrency,
  formatDate,
  formatDateTime,
  formatInteger,
  formatPercent,
  formatPrice,
} from '@/utils/format'

const DAY_MS = 86_400_000

const DIRECTIONS: { value: Direction; label: string }[] = [
  { value: 'long', label: 'Long' },
  { value: 'short', label: 'Short' },
]

const ENTRIES: { value: EntryType; label: string }[] = [
  { value: 'selection_close', label: 'Close of the pattern' },
  { value: 'next_open', label: 'Open of the next bar' },
]

const STOPS: { value: StopLossType; label: string }[] = [
  { value: 'percentage', label: 'Percent of entry' },
  { value: 'atr_multiple', label: 'ATR multiple' },
  { value: 'pattern_extreme', label: 'Pattern high / low' },
  { value: 'fixed_price', label: 'Fixed price' },
]

const TARGETS: { value: TakeProfitType; label: string }[] = [
  { value: 'risk_reward', label: 'Risk / reward multiple' },
  { value: 'liquidity', label: 'Nearest liquidity pool' },
  { value: 'percentage', label: 'Percent of entry' },
  { value: 'fixed_price', label: 'Fixed price' },
]

export function StrategyPanel() {
  const strategy = useWorkspace((state) => state.strategy)
  const setStrategy = useWorkspace((state) => state.setStrategy)
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-3 pt-3 pb-2">
        <SelectField label="Backtest model" value={strategy}
          options={[{ value: 'pattern', label: 'Pattern similarity' }, { value: 'gxt_research', label: 'GXT research (experimental)' }]}
          onChange={setStrategy} />
      </div>
      <div className="min-h-0 flex-1">
        {strategy === 'gxt_research' ? <GxtStrategyPanel /> : <PatternStrategyPanel />}
      </div>
    </div>
  )
}

function PatternStrategyPanel() {
  // Timestamps below are drawn in the zone chosen in the status bar;
  // reading it here is what re-renders them when that changes.
  useTimeZone()

  const primary = useWorkspace((state) => state.primarySymbol)
  /*
   * The interval the setup was drawn on: the primary pane's own, which with
   * the interval link off is not the shared one in the top bar. Reading the
   * shared one looked 5m timestamps up among 1h candles -- the setup sat on
   * "aligning..." with the run disabled, or, when both ends fell on the hour,
   * was priced from 1h bars and run as a 1h backtest of a 5m pattern. The
   * range is the one that pane can load, so the bars below are the chart's.
   */
  const interval = useSymbolInterval(primary)
  const range = useChartRange(interval)
  const higherTimeframe = useWorkspace((state) => state.higherTimeframe)
  const setHigherTimeframe = useWorkspace((state) => state.setHigherTimeframe)
  const selection = useWorkspace((state) => state.selection)
  const testWindow = useWorkspace((state) => state.testWindow)
  const rules = useWorkspace((state) => state.rules)
  const search = useWorkspace((state) => state.search)
  const detectors = useWorkspace((state) => state.detectors)
  const learning = useWorkspace((state) => state.learning)
  const sizing = useWorkspace((state) => state.sizing)

  const setSelection = useWorkspace((state) => state.setSelection)
  const setTestWindow = useWorkspace((state) => state.setTestWindow)
  const setTool = useWorkspace((state) => state.setTool)
  const updateRules = useWorkspace((state) => state.updateRules)
  const updateSearch = useWorkspace((state) => state.updateSearch)
  const updateDetectors = useWorkspace((state) => state.updateDetectors)
  const updateLearning = useWorkspace((state) => state.updateLearning)
  const resetStrategy = useWorkspace((state) => state.resetStrategy)

  // What the fold is worth knowing without opening it. Stands on its own:
  // it needs no setup, no levels and no plan, only the two fields inside.
  const riskBudget = (sizing.accountEquity * sizing.riskPercent) / 100

  const symbols = useChartedSymbols()
  const barsQuery = useBars(primary, interval, range.from, range.to)
  const candles = barsQuery.data?.bars ?? []

  const summary = useMemo(() => {
    if (!selection || candles.length === 0) return null
    const startIndex = indexOfBar(candles, selection.start_time)
    const endIndex = indexOfBar(candles, selection.end_time)
    if (startIndex < 0 || endIndex < 0 || endIndex < startIndex) return null

    const slice = candles.slice(startIndex, endIndex + 1)
    if (slice.length === 0) return null

    const open = slice[0].open
    const close = slice[slice.length - 1].close
    return {
      // Kept so the sizing panel prices the same candles, rather than
      // resolving the selection to indices a second time and possibly
      // disagreeing about which bars the setup covers.
      startIndex,
      endIndex,
      bars: slice.length,
      open,
      close,
      change: open ? ((close - open) / open) * 100 : 0,
      highest: Math.max(...slice.map((candle) => candle.high)),
      lowest: Math.min(...slice.map((candle) => candle.low)),
    }
  }, [candles, selection])

  /**
   * What the setup is, in the few words the header has room for once the
   * section is folded. Collapsing the setup away must not cost you the
   * knowledge of *which* setup you are about to test, so the summary always
   * names it.
   */
  const setupSummary = useMemo(() => {
    if (!selection) return 'nothing selected'
    if (!summary) return selection.symbol
    return `${selection.symbol} · ${formatInteger(summary.bars)} candles`
  }, [selection, summary])

  /** How much of the loaded history the window actually covers. */
  const windowBars = useMemo(() => {
    if (!testWindow || candles.length === 0) return null
    return candles.filter(
      (candle) =>
        candle.time >= testWindow.start_time && candle.time <= testWindow.end_time,
    ).length
  }, [candles, testWindow])

  const runBacktest = useRunBacktest()
  /*
   * Whether a run is in flight, and how the last one failed, are read from the
   * query client and the store rather than from this panel's own mutation.
   * The panel is unmounted by focus mode, the Analysis tab and the collapse
   * button, any of them mid-run: remounted, its own mutation knew of no run --
   * the button was offered again while the first was still going, and a
   * failure that landed meanwhile was never shown.
   */
  const running = useIsMutating({ mutationKey: RUN_BACKTEST_MUTATION_KEY }) > 0
  const runError = useWorkspace((state) => state.runError)

  const tooShort = Boolean(summary && summary.bars < 5)
  const windowTooSmall = windowBars != null && windowBars < 20
  const canRun = Boolean(selection && summary && !tooShort && !running)

  const handleRun = () => {
    if (!selection) return
    const request = buildBacktestRequest({
      selection,
      primarySymbol: primary,
      symbols,
      interval,
      rules,
      search,
      detectors,
      learning,
      rangeEnd: range.to,
      testWindow,
      higherTimeframe,
    })
    // Nothing is passed to `mutate`. Putting the result on screen is the
    // hook's job: options given here are dropped if this panel unmounts
    // before the run lands, and the run then never opened.
    runBacktest.mutate(request)
  }

  return (
    /*
     * The run action is pinned, not merely pushed down. It used to sit at the
     * end of the one scrolling column with `mt-auto`, which places it nicely
     * while the column is short -- and the column is no longer short. With
     * sizing, conditions, fitted weights and advanced all present, the button
     * that runs the thing was below the fold on load, so the panel opened
     * with its primary action out of sight.
     */
    <div className="flex h-full flex-col p-3">
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
      {/*
        Before the setup, because it is what you reach for when you do not
        yet know what you are testing -- and after it in the flow, since
        neither a preset nor a description says which candles to look at.
      */}
      <StrategyStart />

      {/* ---- the setup ---- */}
      <Disclosure
        label="Selected setup"
        defaultOpen
        divided={false}
        summary={setupSummary}
        action={
          selection && (
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5"
              onClick={() => setSelection(null)}
              title="Clear the selection"
              aria-label="Clear selection"
            >
              <X size={12} />
            </Button>
          )
        }
      >
        {!selection ? (
          <div className="rounded-md border border-dashed border-border p-3">
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Nothing selected. Pick the range of candles that forms your setup, and the
              engine will look for it across the rest of the history.
            </p>
            <Button
              size="sm"
              variant="primary"
              className="mt-2 w-full"
              onClick={() => setTool('select')}
            >
              <BoxSelect size={13} />
              Select on the {primary} chart
            </Button>
          </div>
        ) : (
          <div className="space-y-1.5 rounded-md border border-border bg-[hsl(var(--panel-raised))] p-2.5">
            <div className="flex items-center gap-2">
              <Badge tone="accent">{selection.symbol}</Badge>
              <span className="numeric text-2xs text-muted-foreground">
                {summary ? `${formatInteger(summary.bars)} candles` : 'aligning...'}
              </span>
            </div>
            <p className="numeric text-2xs leading-relaxed text-muted-foreground">
              {formatDateTime(selection.start_time)}
              <br />
              {formatDateTime(selection.end_time)}
            </p>
            {summary && (
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-border pt-1.5 text-2xs">
                <Readout label="Change" value={formatPercent(summary.change)} />
                <Readout label="Close" value={formatPrice(summary.close)} />
                <Readout label="High" value={formatPrice(summary.highest)} />
                <Readout label="Low" value={formatPrice(summary.lowest)} />
              </div>
            )}
            {tooShort && (
              <p className="text-2xs leading-relaxed text-amber-400">
                At least 5 candles are needed to describe a pattern. Widen the selection or
                drop to a smaller interval.
              </p>
            )}
          </div>
        )}
      </Disclosure>

      {/* ---- where to test ---- */}
      <section className="space-y-2 border-t border-border pt-2.5">
        <div className="flex items-center justify-between">
          <span className="label-caps">Test window</span>
          {testWindow && (
            <Button
              size="icon"
              variant="ghost"
              className="h-5 w-5"
              onClick={() => setTestWindow(null)}
              title="Test the whole loaded history again"
              aria-label="Clear the test window"
            >
              <X size={12} />
            </Button>
          )}
        </div>

        {testWindow ? (
          <div className="space-y-1 rounded-md border border-border bg-[hsl(var(--panel-raised))] p-2.5">
            <p className="numeric text-2xs text-foreground">
              {formatDate(testWindow.start_time)} &rarr; {formatDate(testWindow.end_time)}
            </p>
            <p className="text-2xs leading-relaxed text-muted-foreground">
              {windowBars == null
                ? 'Aligning to the loaded candles...'
                : `${formatInteger(windowBars)} candles searched. Everything outside stays on the chart and is left alone.`}
            </p>
            {windowTooSmall && (
              <p className="text-2xs leading-relaxed text-amber-400">
                A window this narrow holds too few candles to find much. Widen it, or load
                more history.
              </p>
            )}
          </div>
        ) : (
          <p className="text-2xs leading-relaxed text-muted-foreground">
            Searching the last {effectiveLookbackDays(search.lookbackDays, interval)} days of
            the loaded history.
            {effectiveLookbackDays(search.lookbackDays, interval) < search.lookbackDays &&
              ` ${INTERVAL_LABELS[interval]} charts hold ${MAX_RANGE_DAYS[interval]} days, so that is as far back as a run looks.`}{' '}
            Drag a window on the chart to test one stretch instead.
          </p>
        )}

        <div className="flex gap-2">
          <Button
            size="sm"
            variant="secondary"
            className="flex-1"
            onClick={() => setTool('window')}
          >
            <CalendarRange size={13} />
            {testWindow ? 'Redraw the window' : 'Pick a window on the chart'}
          </Button>
        </div>

        {!testWindow && (
          <NumberField
            label="Lookback"
            hint="How far back to search when no window is drawn"
            value={search.lookbackDays}
            min={7}
            max={730}
            // Whole days: the request turns this into millisecond bounds the
            // backend takes as integers, and half a day of them is not one.
            integer
            suffix="d"
            onChange={(lookbackDays) => updateSearch({ lookbackDays })}
          />
        )}
      </section>

      {/* ---- trade rules ---- */}
      <section className="space-y-2 border-t border-border pt-2.5">
        <span className="label-caps">Trade rules</span>

        <SelectField<Direction>
          label="Direction"
          value={rules.direction}
          options={DIRECTIONS}
          onChange={(direction) => updateRules({ direction })}
        />

        <div className="grid grid-cols-2 gap-2">
          <SelectField<StopLossType>
            label="Stop loss"
            value={rules.stop_loss_type}
            options={STOPS}
            onChange={(stop_loss_type) => updateRules({ stop_loss_type })}
          />
          <NumberField
            label="Stop value"
            value={rules.stop_loss_value}
            // Strictly positive for every stop it applies to: a stop of zero
            // is no stop, and the backend refuses the run over it.
            min={0}
            minExclusive
            step={0.1}
            disabled={rules.stop_loss_type === 'pattern_extreme'}
            onChange={(stop_loss_value) => updateRules({ stop_loss_value })}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <SelectField<TakeProfitType>
            label="Take profit"
            value={rules.take_profit_type}
            options={TARGETS}
            onChange={(take_profit_type) => updateRules({ take_profit_type })}
          />
          <NumberField
            label={rules.take_profit_type === 'liquidity' ? 'Minimum reward' : 'Target value'}
            hint={
              rules.take_profit_type === 'liquidity'
                ? 'The least a pool must be worth to be traded to, in multiples of the risk. A shelf closer than this skips the match rather than being taken: a target two points away fills nearly every time and reports a win rate the strategy has not earned.'
                : 'With risk/reward, 2 means the target sits twice the stop distance away'
            }
            value={rules.take_profit_value}
            min={0}
            minExclusive
            step={0.1}
            onChange={(take_profit_value) => updateRules({ take_profit_value })}
          />
        </div>
        {rules.take_profit_type === 'liquidity' && (
          <p className="mt-1 text-2xs leading-relaxed text-muted-foreground">
            The target is the nearest shelf of equal {rules.direction === 'long' ? 'highs' : 'lows'}{' '}
            standing in front of the entry, as known at that bar. Every level in between has
            to be cleared first, so the near one is the one with the odds. A match with
            nothing in front of it is skipped and counted.
          </p>
        )}
      </section>

      {/*
        ---- sizing ----
        Folded, and opened by the thing that makes it answerable. What a setup
        risks in money is worth knowing when there is a setup; with nothing
        selected it is a third of the panel spent on two empty cards, and the
        rules that actually drive a run are pushed below the fold instead. The
        budget stays on the header so the section is never a mystery box.
      */}
      <Disclosure
        label="Sizing"
        summary={`${formatCurrency(riskBudget, 0)} at risk`}
        defaultOpen={selection != null}
      >
        <PositionSizing
          candles={candles}
          setup={
            summary ? { startIndex: summary.startIndex, endIndex: summary.endIndex } : null
          }
        />
      </Disclosure>

      {/* ---- what has to be standing for a match to count ---- */}
      <Disclosure label="Conditions" summary={conditionsSummary(detectors)}>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          A match that fails these is found but not traded. Each is read at the
          bar the trade opens on, using only what had been confirmed by then.
        </p>

        <ToggleField
          label="Inside a fair value gap"
          hint="The entry price sat in a gap that was still unfilled at the time"
          checked={detectors.require_fair_value_gap}
          onChange={(require_fair_value_gap) =>
            updateDetectors({ require_fair_value_gap })
          }
        />
        {detectors.require_fair_value_gap && (
          <div className="pl-3">
            <ToggleField
              label="Past the gap midpoint"
              hint="Narrow it to the deeper half of the zone -- consequent encroachment. A gap offers two entries: its edge, and its middle line. This asks for the second."
              checked={detectors.gap_past_midpoint}
              onChange={(gap_past_midpoint) => updateDetectors({ gap_past_midpoint })}
            />
          </div>
        )}
        <ToggleField
          label="SMT divergence"
          hint="The two symbols had already disagreed at a confirmed pivot"
          checked={detectors.require_smt_divergence}
          onChange={(require_smt_divergence) => updateDetectors({ require_smt_divergence })}
        />
        <ToggleField
          label="Swing point"
          hint="A pivot had been confirmed, not merely formed"
          checked={detectors.require_swing_point}
          onChange={(require_swing_point) => updateDetectors({ require_swing_point })}
        />
        <ToggleField
          label="Liquidity sweep"
          hint="A shelf of equal highs or lows had just been taken out. A long wants the lows swept -- the stops below the level are cleared and price turns back up."
          checked={detectors.require_liquidity_sweep}
          onChange={(require_liquidity_sweep) =>
            updateDetectors({ require_liquidity_sweep })
          }
        />

        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Look back"
            hint="How recently a swing or divergence must have been confirmed. Gaps are exempt: they stand until filled."
            value={detectors.within_bars}
            min={1}
            max={500}
            integer
            suffix="bars"
            onChange={(within_bars) => updateDetectors({ within_bars })}
          />
          <NumberField
            label="Swing strength"
            hint="Bars either side a pivot must exceed before it counts as confirmed"
            value={detectors.swing_strength}
            min={1}
            max={20}
            integer
            onChange={(swing_strength) => updateDetectors({ swing_strength })}
          />
        </div>

        <ToggleField
          label="Match the trade direction"
          hint="A long wants a bullish gap, a bullish divergence and a swing low"
          checked={detectors.align_with_direction}
          onChange={(align_with_direction) => updateDetectors({ align_with_direction })}
        />
      </Disclosure>

      {/* ---- the frame the entry sits inside ---- */}
      <Disclosure label="Higher timeframe" summary={biasSummary(detectors, higherTimeframe)}>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          The day has a direction before an entry is considered, read from a
          coarser timeframe: bullish once it closes above the last swing high,
          bearish once it closes below the last swing low. It is an assumption
          you trade inside, not a prediction.
        </p>

        <ToggleField
          label="Trade with the higher timeframe"
          hint="Longs only while it is bullish, shorts only while it is bearish. A timeframe that has not broken structure either way is behind nothing, and takes no trades."
          checked={detectors.require_higher_timeframe_bias}
          disabled={!canReadBias(interval)}
          onChange={(require_higher_timeframe_bias) =>
            updateDetectors({ require_higher_timeframe_bias })
          }
        />

        {/* Amber, like the panel's other warnings: `text-warn` was never a token. */}
        {!canReadBias(interval) && (
          <p className="text-2xs leading-relaxed text-amber-400">
            {interval === '1mo'
              ? `${INTERVAL_LABELS[interval]} is the coarsest timeframe there is, so there is nothing above it to read a bias from.`
              : `No higher timeframe is composed of whole ${INTERVAL_LABELS[interval]} bars.`}
          </p>
        )}

        {detectors.require_higher_timeframe_bias && canReadBias(interval) && (
          <>
            <SelectField<Interval>
              label="Read it from"
              hint="Aggregated from the bars already loaded, so switching this on costs no extra data. It must be composed of whole entry bars."
              value={higherTimeframe}
              options={INTERVALS.filter((item) => validBiasInterval(interval, item)).map(
                (item) => ({ value: item, label: INTERVAL_LABELS[item] }),
              )}
              onChange={setHigherTimeframe}
            />
            <p className="text-2xs leading-relaxed text-muted-foreground">
              Read from the <em>close</em> of each {INTERVAL_LABELS[higherTimeframe]}{' '}
              bar, never its open — so a trade never sees a higher-timeframe bar
              that had not finished yet.
            </p>
          </>
        )}
      </Disclosure>

      {/* ---- how price behaved at the level, and which entry off it ---- */}
      <Disclosure label="Entry" summary={entrySummary(detectors)}>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Two things about the entry itself: whether the bar at the level
          actually rejected, and which of the two entries off that level you
          are taking.
        </p>

        <ToggleField
          label="Needs a reaction"
          hint="The bar at the level closed back through its own open, with a rejection wick. A bar that touched and drifted is not a reaction."
          checked={detectors.require_reaction}
          onChange={(require_reaction) => updateDetectors({ require_reaction })}
        />

        {detectors.require_reaction && (
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="Wick at least"
              hint="The rejection wick as a share of the bar's whole range. 0.5 asks for half the bar to be wick."
              value={detectors.min_wick_ratio}
              min={0}
              max={1}
              step={0.05}
              onChange={(min_wick_ratio) => updateDetectors({ min_wick_ratio })}
            />
            <NumberField
              label="Came back"
              hint="How far price travelled from the extreme to the close. 0 asks only for the shape, which is the weaker claim -- a bar can be all wick and have moved almost nothing."
              value={detectors.min_reaction_percent}
              min={0}
              max={50}
              step={0.05}
              suffix="%"
              onChange={(min_reaction_percent) => updateDetectors({ min_reaction_percent })}
            />
          </div>
        )}

        <SelectField<DetectorFilters['entry_model']>
          label="Entry off the level"
          hint="Turn straight off it, or wait for price to come back into the retracement of the last swing leg. Two different trades; a run that mixes them measures neither."
          value={detectors.entry_model}
          options={[
            { value: 'any', label: 'Either' },
            { value: 'immediate', label: 'Immediate' },
            { value: 'fib_retrace', label: 'Fib retracement' },
          ]}
          onChange={(entry_model) => updateDetectors({ entry_model })}
        />

        {detectors.entry_model === 'fib_retrace' && (
          <div className="grid grid-cols-2 gap-2">
            <NumberField
              label="From"
              hint="The shallow edge of the band, as a fraction of the leg"
              value={detectors.fib_low}
              min={0}
              // Each edge is bounded by the other: a band whose shallow edge
              // is deeper than its deep one is refused by the backend.
              max={detectors.fib_high}
              step={0.01}
              onChange={(fib_low) => updateDetectors({ fib_low })}
            />
            <NumberField
              label="To"
              hint="The deep edge. 0.62 to 0.79 is the optimal trade entry."
              value={detectors.fib_high}
              min={detectors.fib_low}
              max={1}
              step={0.01}
              onChange={(fib_high) => updateDetectors({ fib_high })}
            />
          </div>
        )}
      </Disclosure>

      {/* ---- when in the day ---- */}
      <Disclosure label="Sessions" summary={sessionSummary(detectors)}>
        <p className="text-2xs leading-relaxed text-muted-foreground">
          A setup that only works at the New York open and one that works all
          day are different setups. With none selected there is no filter at
          all — every hour is allowed.
        </p>

        {SESSION_KEYS.map((key) => (
          <ToggleField
            key={key}
            label={SESSION_LABELS[key]}
            hint={SESSION_HOURS[key]}
            checked={detectors.sessions.includes(key)}
            onChange={(on) =>
              updateDetectors({
                // Kept in the canonical order rather than the order they were
                // pressed, so the summary line reads the same way every time.
                sessions: SESSION_KEYS.filter((item) =>
                  item === key ? on : detectors.sessions.includes(item),
                ),
              })
            }
          />
        ))}
      </Disclosure>

      {/* ---- weights fitted rather than assumed ---- */}
      <Disclosure
        label="Fitted weights"
        summary={
          learning.enabled
            ? `${learning.query_samples} queries, train on ${Math.round(learning.train_fraction * 100)}%`
            : 'off'
        }
      >
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Chooses how much each feature counts toward &ldquo;these look alike&rdquo;
          by fitting to what the matches actually paid. The lookback is split:
          fitted on the earlier part, measured on the later, so the result is
          never read off the data the weights were chosen on.
        </p>

        <ToggleField
          label="Fit the similarity weights"
          hint="Off uses the hand-set weights, which is how every run above worked"
          checked={learning.enabled}
          onChange={(enabled) => updateLearning({ enabled })}
        />

        {learning.enabled && (
          <SelectField<LearningSettings['objective']>
            label="Fit for"
            hint="Expectancy is mean net return, which rewards big moves. Win rate counts only whether a trade finished up."
            value={learning.objective}
            options={[
              { value: 'expectancy', label: 'Expectancy' },
              { value: 'win_rate', label: 'Win rate' },
            ]}
            onChange={(objective) => updateLearning({ objective })}
          />
        )}

        {learning.enabled && (
          <ToggleField
            label="Three weights, not seven"
            hint="Fits path, candle and context as groups. Fewer parameters for a noisy objective, and the whole space is searched rather than walked."
            checked={learning.grouped}
            onChange={(grouped) => updateLearning({ grouped })}
          />
        )}

        {learning.enabled && (
          <NumberField
            label="Ask from"
            hint="Windows across the training half used as queries. Fitting to one window lets seven parameters memorise its neighbourhood; asking from many tests whether similarity is predictive at all."
            value={learning.query_samples}
            min={1}
            max={400}
            integer
            suffix="windows"
            onChange={(query_samples) => updateLearning({ query_samples })}
          />
        )}

        {learning.enabled && (
          <NumberField
            label="Train on"
            hint="Share of the lookback used to fit. The rest is what the result is measured on, so more training means a smaller out-of-sample window."
            value={Math.round(learning.train_fraction * 100)}
            min={20}
            max={80}
            step={5}
            suffix="%"
            onChange={(percent) => updateLearning({ train_fraction: percent / 100 })}
          />
        )}
      </Disclosure>

      {/* ---- everything set once ---- */}
      <Disclosure
        label="Advanced"
        summary={`entry, costs, ${search.maximumMatches} matches`}
      >
        <SelectField<EntryType>
          label="Entry"
          hint="Where the position is opened once a match is found"
          value={rules.entry_type}
          options={ENTRIES}
          onChange={(entry_type) => updateRules({ entry_type })}
        />

        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Max hold"
            hint="Bars before an open position is closed at the market"
            value={rules.maximum_holding_bars}
            min={1}
            max={2000}
            integer
            suffix="bars"
            onChange={(maximum_holding_bars) => updateRules({ maximum_holding_bars })}
          />
          <NumberField
            label="ATR period"
            value={rules.atr_period}
            min={2}
            max={200}
            integer
            disabled={rules.stop_loss_type !== 'atr_multiple'}
            onChange={(atr_period) => updateRules({ atr_period })}
          />
        </div>

        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Fees"
            hint="Charged on entry and exit, as a percentage of notional"
            value={rules.fee_percent}
            min={0}
            max={5}
            step={0.01}
            suffix="%"
            onChange={(fee_percent) => updateRules({ fee_percent })}
          />
          <NumberField
            label="Slippage"
            hint="Worsens both the entry and the exit price"
            value={rules.slippage_percent}
            min={0}
            max={5}
            step={0.01}
            suffix="%"
            onChange={(slippage_percent) => updateRules({ slippage_percent })}
          />
        </div>

        <ToggleField
          label="Allow overlapping trades"
          hint="Off means a match that starts before the previous trade exits is skipped"
          checked={rules.allow_overlapping_trades}
          onChange={(allow_overlapping_trades) => updateRules({ allow_overlapping_trades })}
        />

        <div className="grid grid-cols-2 gap-2">
          <NumberField
            label="Max matches"
            value={search.maximumMatches}
            min={1}
            max={25}
            integer
            onChange={(maximumMatches) => updateSearch({ maximumMatches })}
          />
          <NumberField
            label="Min similarity"
            hint="1.0 is an identical shape. Lower finds more matches of lower quality."
            value={search.minimumSimilarity}
            min={-1}
            max={1}
            step={0.01}
            onChange={(minimumSimilarity) => updateSearch({ minimumSimilarity })}
          />
        </div>

        {/*
          What the run will actually search, worked out by the same rule the
          request is built with. It listed every charted market, which was
          wrong twice over: a description naming one market narrows the
          search to it, and a market brought in for an SMT condition is
          compared against, never searched or traded.
        */}
        <p className="text-2xs leading-relaxed text-muted-foreground">
          {(() => {
            const plan = searchedSymbols({ primarySymbol: primary, symbols, search, detectors })
            const searched = plan.symbols.filter((item) => !plan.addedForSmt.includes(item))
            return (
              <>
                Searching {searched.join(', ')}.
                {plan.addedForSmt.length > 0 &&
                  ` ${plan.addedForSmt.join(', ')} is read for the SMT condition only, never searched or traded.`}{' '}
              </>
            )
          })()}
          The selected window itself is always excluded, so a setup is never matched
          against itself.
        </p>
      </Disclosure>

      </div>

      {/* ---- run: always reachable, whatever is open above ---- */}
      <section className="shrink-0 space-y-2 border-t border-border pt-2.5 mt-3">
        {runError && !running && (
          <p className="rounded-md border border-bear/30 bg-bear/10 p-2 text-2xs leading-relaxed text-bear">
            {runError}
          </p>
        )}

        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" disabled={!canRun} onClick={handleRun}>
            {running ? <Spinner /> : <Play size={14} />}
            {running ? 'Testing...' : 'Test strategy'}
          </Button>
          <Button
            size="icon"
            variant="secondary"
            onClick={resetStrategy}
            title="Reset rules to defaults"
            aria-label="Reset rules"
          >
            <RotateCcw size={14} />
          </Button>
        </div>

        <p className="text-2xs leading-relaxed text-muted-foreground">
          {selection
            ? `Every match found in the ${
                testWindow
                  ? `${Math.max(1, Math.round((testWindow.end_time - testWindow.start_time) / DAY_MS))}-day window`
                  : 'searched history'
              } is traded by these rules, and the results are drawn on the chart.`
            : 'Select a setup to enable the run.'}
        </p>
      </section>
    </div>
  )
}

function Readout({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="numeric">{value}</span>
    </div>
  )
}


/** "off" reads better than "0 of 3" for the common case of asking nothing. */
function conditionsSummary(detectors: DetectorFilters): string {
  const on = [
    detectors.require_fair_value_gap && 'fair value gap',
    detectors.require_smt_divergence && 'SMT',
    detectors.require_swing_point && 'swing',
    detectors.require_liquidity_sweep && 'sweep',
  ].filter(Boolean) as string[]

  if (on.length === 0) return 'none required'
  return on.join(', ')
}

/** Names the timeframe, because "on" alone does not say which one. */
function biasSummary(detectors: DetectorFilters, higher: Interval): string {
  if (!detectors.require_higher_timeframe_bias) return 'any direction'
  return `with the ${INTERVAL_LABELS[higher]}`
}

function entrySummary(detectors: DetectorFilters): string {
  const parts: string[] = []
  if (detectors.entry_model === 'fib_retrace') {
    parts.push(`${detectors.fib_low}-${detectors.fib_high} retrace`)
  } else if (detectors.entry_model === 'immediate') {
    parts.push('immediate')
  }
  if (detectors.require_reaction) {
    parts.push(`${Math.round(detectors.min_wick_ratio * 100)}% wick`)
  }
  return parts.length ? parts.join(', ') : 'anywhere on the level'
}

function sessionSummary(detectors: DetectorFilters): string {
  if (detectors.sessions.length === 0) return 'any hour'
  if (detectors.sessions.length === SESSION_KEYS.length) return 'every session'
  return detectors.sessions.map((key) => SESSION_LABELS[key]).join(', ')
}
