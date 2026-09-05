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
import { BoxSelect, CalendarRange, Play, RotateCcw, X } from 'lucide-react'

import { PositionSizing } from '@/components/panels/PositionSizing'
import { NumberField, SelectField, ToggleField } from '@/components/ui/fields'
import { Badge, Button, Disclosure, Spinner } from '@/components/ui/primitives'
import { useChartRange } from '@/hooks/useChartRange'
import { useBars } from '@/hooks/useMarketData'
import { buildBacktestRequest, useRunBacktest } from '@/hooks/useBacktest'
import { useChartedSymbols, useTimeZone, useWorkspace } from '@/store/workspace'
import type {
  Direction,
  EntryType,
  StopLossType,
  TakeProfitType,
} from '@/types/backtest'
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
  { value: 'percentage', label: 'Percent of entry' },
  { value: 'fixed_price', label: 'Fixed price' },
]

export function StrategyPanel() {
  // Timestamps below are drawn in the zone chosen in the status bar;
  // reading it here is what re-renders them when that changes.
  useTimeZone()

  const range = useChartRange()
  const interval = useWorkspace((state) => state.interval)
  const primary = useWorkspace((state) => state.primarySymbol)
  const selection = useWorkspace((state) => state.selection)
  const testWindow = useWorkspace((state) => state.testWindow)
  const rules = useWorkspace((state) => state.rules)
  const search = useWorkspace((state) => state.search)
  const sizing = useWorkspace((state) => state.sizing)

  const setSelection = useWorkspace((state) => state.setSelection)
  const setTestWindow = useWorkspace((state) => state.setTestWindow)
  const setTool = useWorkspace((state) => state.setTool)
  const updateRules = useWorkspace((state) => state.updateRules)
  const updateSearch = useWorkspace((state) => state.updateSearch)
  const resetStrategy = useWorkspace((state) => state.resetStrategy)
  const setActiveBacktestId = useWorkspace((state) => state.setActiveBacktestId)

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

  const tooShort = Boolean(summary && summary.bars < 5)
  const windowTooSmall = windowBars != null && windowBars < 20
  const canRun = Boolean(selection && summary && !tooShort && !runBacktest.isPending)

  const handleRun = () => {
    if (!selection) return
    const request = buildBacktestRequest({
      selection,
      primarySymbol: primary,
      symbols,
      interval,
      rules,
      search,
      rangeEnd: range.to,
      testWindow,
    })
    runBacktest.mutate(request, {
      onSuccess: (result) => setActiveBacktestId(result.id),
    })
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
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
            Searching the last {search.lookbackDays} days of the loaded history. Drag a
            window on the chart to test one stretch instead.
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
            min={0}
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
            label="Target value"
            hint="With risk/reward, 2 means the target sits twice the stop distance away"
            value={rules.take_profit_value}
            min={0}
            step={0.1}
            onChange={(take_profit_value) => updateRules({ take_profit_value })}
          />
        </div>
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
            suffix="bars"
            onChange={(maximum_holding_bars) => updateRules({ maximum_holding_bars })}
          />
          <NumberField
            label="ATR period"
            value={rules.atr_period}
            min={2}
            max={200}
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

        <p className="text-2xs leading-relaxed text-muted-foreground">
          Searching {symbols.join(', ')}. The selected window itself is always excluded, so
          a setup is never matched against itself.
        </p>
      </Disclosure>

      {/* ---- run ---- */}
      <section className="mt-auto space-y-2 border-t border-border pt-2.5">
        {runBacktest.isError && (
          <p className="rounded-md border border-bear/30 bg-bear/10 p-2 text-2xs leading-relaxed text-bear">
            {(runBacktest.error as Error).message}
          </p>
        )}

        <div className="flex gap-2">
          <Button variant="primary" className="flex-1" disabled={!canRun} onClick={handleRun}>
            {runBacktest.isPending ? <Spinner /> : <Play size={14} />}
            {runBacktest.isPending ? 'Testing...' : 'Test strategy'}
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
