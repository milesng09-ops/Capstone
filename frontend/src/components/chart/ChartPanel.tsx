/** One instrument's chart: candles, overlays and a legend laid over them. */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Maximize2 } from 'lucide-react'

import { ChartSettingsBody } from '@/components/chart/ToolRail'

import { PaneIntervalButton } from '@/components/layout/IntervalPicker'
import { ChartOverlay } from '@/components/chart/ChartOverlay'
import { DrawingActions } from '@/components/chart/DrawingActions'
import { useChartInstance } from '@/components/chart/useChartInstance'
import { Floating } from '@/components/ui/Floating'
import { Badge, Button, Spinner } from '@/components/ui/primitives'
import { useBacktestResult } from '@/hooks/useBacktest'
import { useChartRange } from '@/hooks/useChartRange'
import { newId } from '@/lib/id'
import { sessionChange } from '@/lib/marketHours'
import {
  useBars,
  useDetectionsFollowBars,
  useIct,
  useMarketOpen,
} from '@/hooks/useMarketData'
import {
  collectEvidence,
  evidenceWindow,
  findMatch,
  findTrade,
  tradesForSymbol,
} from '@/lib/trades'
import { useChartedSymbols, useSymbolInterval, useWorkspace } from '@/store/workspace'
import type { DrawingDraft } from '@/types/drawing'
import {
  INTERVAL_LABELS,
  QUALITY_LABELS,
  UNRELIABLE_QUALITIES,
  type Candle,
  type DataQuality,
  type SymbolKey,
} from '@/types/market'
import { cn } from '@/utils/cn'
import {
  directionClass,
  formatClock,
  formatCompact,
  formatPercent,
  formatPrice,
} from '@/utils/format'

/** Fetching something not yet on screen -- not a refresh of what already is. */
function loading(query: { isFetching: boolean; isPlaceholderData: boolean; data?: unknown }) {
  return query.isFetching && (query.isPlaceholderData || query.data === undefined)
}

interface Props {
  symbol: SymbolKey
  isPrimary: boolean
  precision?: number
  className?: string
}

export function ChartPanel({ symbol, isPrimary, precision = 2, className }: Props) {
  // With the interval link off this pane keeps its own bar size, which is
  // how structure on the weekly is read against entries on the 3-minute.
  const interval = useSymbolInterval(symbol)
  // Held to what this pane's own interval can carry: 180 days of 1-minute
  // bars is a request the backend refuses outright.
  const range = useChartRange(interval)
  const intervalLinked = useWorkspace((state) => state.chartSync.interval)
  const setSymbolInterval = useWorkspace((state) => state.setSymbolInterval)
  const ictSettings = useWorkspace((state) => state.ict)
  const tool = useWorkspace((state) => state.tool)
  const drawingColor = useWorkspace((state) => state.drawingColor)
  const drawingWidth = useWorkspace((state) => state.drawingWidth)
  const magnet = useWorkspace((state) => state.magnet)
  const chartSettings = useWorkspace((state) => state.chartSettings)
  const allDrawings = useWorkspace((state) => state.drawings)
  const selectedDrawingId = useWorkspace((state) => state.selectedDrawingId)
  const snapToSwings = useWorkspace((state) => state.snapToSwings)
  const selection = useWorkspace((state) => state.selection)
  const testWindow = useWorkspace((state) => state.testWindow)
  const showTrades = useWorkspace((state) => state.showTrades)
  const selectedTradeId = useWorkspace((state) => state.selectedTradeId)
  const activeBacktestId = useWorkspace((state) => state.activeBacktestId)
  const addDrawing = useWorkspace((state) => state.addDrawing)
  const updateDrawing = useWorkspace((state) => state.updateDrawing)
  const selectDrawing = useWorkspace((state) => state.selectDrawing)
  const setSelection = useWorkspace((state) => state.setSelection)
  const setTestWindow = useWorkspace((state) => state.setTestWindow)
  const selectTrade = useWorkspace((state) => state.selectTrade)
  const setTool = useWorkspace((state) => state.setTool)

  const charted = useChartedSymbols()
  const references = useMemo(
    () => charted.filter((item) => item !== symbol),
    // `charted` is rebuilt each render; its contents are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [charted.join(','), symbol],
  )

  // Live while the market trades: the newest bar is asked for again every
  // minute, so the price, the last candle and the axis label keep moving.
  const marketOpen = useMarketOpen()
  const barsQuery = useBars(symbol, interval, range.from, range.to, true, marketOpen)
  const ictQuery = useIct(symbol, interval, range.from, range.to, references, ictSettings)

  const candles = useMemo(() => barsQuery.data?.bars ?? [], [barsQuery.data])
  useDetectionsFollowBars(symbol, interval, range.from, range.to, candles.at(-1)?.time ?? null)
  const drawings = useMemo(
    () => allDrawings.filter((drawing) => drawing.symbol === symbol),
    [allDrawings, symbol],
  )

  // The run on screen, if any. Cached by id, so every pane reads the same
  // response rather than fetching one each.
  const backtestQuery = useBacktestResult(activeBacktestId)
  const symbolTrades = useMemo(() => {
    if (!backtestQuery.data) return []
    return tradesForSymbol(backtestQuery.data.trades, symbol)
  }, [backtestQuery.data, symbol])

  // Drawing the boxes is a separate question from having them: with the
  // boxes switched off, a trade picked from the table still explains itself.
  const trades = showTrades ? symbolTrades : []

  /**
   * What the engine was looking at when it took the selected trade.
   *
   * Only assembled for the chart the trade was actually taken on -- the same
   * timestamps on a correlated market are a different set of bars and would
   * explain nothing.
   */
  const evidence = useMemo(() => {
    if (!ictSettings.showTradeEvidence || !backtestQuery.data) return null
    if (backtestQuery.data.summary?.gxt) return null
    const trade = findTrade(symbolTrades, selectedTradeId)
    if (!trade) return null
    const match = findMatch(backtestQuery.data.matches, trade)
    return collectEvidence(ictQuery.data, evidenceWindow(trade, match))
  }, [
    backtestQuery.data,
    ictQuery.data,
    ictSettings.showTradeEvidence,
    selectedTradeId,
    symbolTrades,
  ])

  const [hovered, setHovered] = useState<Candle | null>(null)

  const { containerRef, handle, ready, resetView } = useChartInstance({
    id: `chart-${symbol}`,
    candles,
    interval,
    // The span, not the bounds: the window's end moves on with every hour,
    // and a refit each time it did would throw away the user's zoom.
    view: String(range.to - range.from),
    settled: !barsQuery.isPlaceholderData,
    precision,
    onHoverBar: setHovered,
    settings: chartSettings,
  })

  const handleCreate = useCallback(
    (drawing: DrawingDraft) => {
      // Not crypto.randomUUID: it exists only on secure origins, so over plain
      // http on a LAN address every drawing threw on release.
      addDrawing({ ...drawing, id: newId(), createdAt: Date.now() })
    },
    [addDrawing],
  )

  const handleGestureComplete = useCallback(
    (committed: boolean) => {
      // Drop back to the cursor so the next drag pans the chart, matching how
      // every charting platform behaves after a shape is placed -- but only
      // when something was actually placed. Releasing the tool on a misfire
      // or an Escape made a mis-click cost the tool as well as the shape.
      if (committed) setTool('cursor')
    },
    [setTool],
  )

  /*
   * Where the legend ends, so the range tabs can start below it. They used to
   * be painted at a fixed spot in the same corner, under the symbol and the
   * OHLC row -- and with the interval link off, under the pane's interval
   * button, which took the click meant for the tab. Measured, because the
   * legend wraps onto more lines in a narrow pane.
   */
  const legendRef = useRef<HTMLDivElement | null>(null)
  const [legendBottom, setLegendBottom] = useState(0)
  useEffect(() => {
    const legend = legendRef.current
    if (!legend) return
    const measure = () => setLegendBottom(legend.offsetTop + legend.offsetHeight)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(legend)
    return () => observer.disconnect()
  }, [])

  const last = candles.at(-1)
  const change = useMemo(() => sessionChange(candles, interval), [candles, interval])

  const readout = hovered ?? last
  // Before a response arrives we genuinely do not know where the bars came
  // from, so the badge must say so rather than assert a clean cache hit.
  const quality = (barsQuery.data?.quality ?? 'unknown') as DataQuality

  return (
    <div
      className={cn(
        'panel relative min-h-0 overflow-hidden',
        // The primary chart is the one selections and backtests run against,
        // so it is marked -- inset, because a flush layout leaves no gap
        // outside the pane for a ring to sit in.
        isPrimary && 'ring-1 ring-inset ring-primary/25',
        className,
      )}
    >
      <div ref={containerRef} className="absolute inset-0" />

      <ChartContextMenu />

      {/*
       * The legend sits over the candles instead of in a title bar above them.
       * In a stack of three charts, 32px of header each is a tenth of the
       * screen spent on labels -- and the top-left corner of a price pane is
       * reliably empty, which is why charting platforms all put it there.
       */}
      <div
        ref={legendRef}
        className="chart-legend pointer-events-none absolute left-2 top-1.5 z-20 flex flex-col gap-0.5"
      >
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tracking-tight">{symbol}</span>
          {intervalLinked ? (
            <span className="text-muted-foreground">{INTERVAL_LABELS[interval]}</span>
          ) : (
            <PaneIntervalButton
              value={interval}
              onChange={(next) => setSymbolInterval(symbol, next)}
            />
          )}

          {last && (
            <span
              className={cn('numeric pointer-events-auto', directionClass(change?.percent ?? 0))}
              title={
                change
                  ? `${formatPercent(change.percent)} ${change.since} (${formatPrice(change.reference, precision)})`
                  : undefined
              }
            >
              {formatPrice(last.close, precision)}
              {change && <span className="ml-1">{formatPercent(change.percent)}</span>}
            </span>
          )}

          {isPrimary && (
            <Badge
              tone="accent"
              className="pointer-events-auto"
              title="Selections and backtests run on this chart"
            >
              Primary
            </Badge>
          )}

          <Badge
            tone={UNRELIABLE_QUALITIES.has(quality) ? 'warn' : 'neutral'}
            className="pointer-events-auto"
            title={
              quality === 'demo'
                ? 'Synthetic data generated from a fixed seed. Not real market prices.'
                : quality === 'partial'
                  ? // A quota is worth saying out loud even though the reason
                    // string also mentions it: "this clears by itself" is the
                    // part that decides whether the user waits or goes
                    // hunting for a broken setting.
                    barsQuery.data?.rate_limited
                    ? `The provider is rate limiting us, so part of this window is missing. It clears on its own. ${
                        barsQuery.data?.fallback_reason ?? ''
                      }`.trim()
                    : barsQuery.data?.fallback_reason ??
                      'Part of this window could not be fetched. Bars may be missing.'
                  : `Source: ${barsQuery.data?.provider ?? 'unknown'}${
                      barsQuery.dataUpdatedAt
                        ? `, updated ${formatClock(barsQuery.dataUpdatedAt)}${
                            marketOpen ? ', refreshed every minute' : ', market closed'
                          }`
                        : ''
                    }`
            }
          >
            {QUALITY_LABELS[quality] ?? quality}
          </Badge>

          {/*
            Loading, not refreshing: the live price is asked for again every
            minute, and a spinner flashing up each time says "something is
            wrong" about the one thing that is working.
          */}
          {(loading(barsQuery) || loading(ictQuery)) && (
            <Spinner className="text-muted-foreground" />
          )}

          <Button
            size="icon"
            variant="ghost"
            className="pointer-events-auto h-5 w-5"
            onClick={resetView}
            title="Reset the chart: fit every candle and re-enable price autoscaling (R)"
            aria-label={`Reset the ${symbol} chart`}
          >
            <Maximize2 size={11} />
          </Button>
        </div>

        {readout && (
          <div className="flex gap-2.5">
            {(
              [
                ['O', readout.open],
                ['H', readout.high],
                ['L', readout.low],
                ['C', readout.close],
              ] as const
            ).map(([key, value]) => (
              <span key={key} className="numeric text-muted-foreground">
                {key}
                <span
                  className={cn(
                    'ml-1',
                    readout.close >= readout.open ? 'text-bull' : 'text-bear',
                  )}
                >
                  {formatPrice(value, precision)}
                </span>
              </span>
            ))}
            <span className="numeric text-muted-foreground">
              {formatCompact(candles.length)} bars
            </span>
          </div>
        )}
      </div>

      {ready && candles.length > 0 && (
        <ChartOverlay
          symbol={symbol}
          handle={handle}
          candles={candles}
          interval={interval}
          ict={ictQuery.data}
          ictSettings={ictSettings}
          drawings={drawings}
          selection={selection?.symbol === symbol ? selection : null}
          testWindow={isPrimary ? testWindow : null}
          trades={trades}
          strategyLabel={backtestQuery.data?.summary?.gxt ? 'GXT research' : undefined}
          gxtEvidence={ictSettings.showTradeEvidence
            ? backtestQuery.data?.summary?.gxt?.evidence[
              findTrade(symbolTrades, selectedTradeId)?.pattern_match_id ?? ''
            ] : undefined}
          selectedTradeId={selectedTradeId}
          evidence={evidence}
          tool={tool}
          drawingColor={drawingColor}
          drawingWidth={drawingWidth}
          magnet={magnet}
          selectedDrawingId={selectedDrawingId}
          snapToSwings={snapToSwings}
          allowSelection={isPrimary}
          // While a new interval loads, the previous interval's bars stay on
          // screen; a setup marked across them is not made of the bars it
          // would be tested on.
          rangesReady={(barsQuery.data?.interval ?? interval) === interval}
          precision={precision}
          chipTop={legendBottom + 6}
          onCreateDrawing={handleCreate}
          onUpdateDrawing={updateDrawing}
          onSelectDrawing={selectDrawing}
          onSelectionChange={setSelection}
          onTestWindowChange={setTestWindow}
          onSelectTrade={selectTrade}
          onGestureComplete={handleGestureComplete}
        />
      )}

      {ready && candles.length > 0 && (
        <DrawingActions symbol={symbol} handle={handle} drawings={drawings} />
      )}

      {barsQuery.isLoading && (
        <div className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <Spinner /> Loading {symbol}...
          </span>
        </div>
      )}

      {barsQuery.isError && (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-bear">
          {(barsQuery.error as Error).message}
        </div>
      )}

      {!barsQuery.isLoading && !barsQuery.isError && candles.length === 0 && (
        <div className="absolute inset-0 grid place-items-center p-4 text-center text-xs text-muted-foreground">
          {/*
            An empty pane has two causes that want opposite responses. A quota
            clears by itself and the range is fine; saying "try a longer
            history" there sends the user to change a setting that was never
            the problem, which is most of what the 2026-09-05 review spent its
            time on.
          */}
          {barsQuery.data?.rate_limited
            ? `The data provider's request limit is reached, so this range has not been
               fetched yet. It clears on its own -- no setting needs changing.`
            : `No candles for ${symbol} in this range. Try a longer history or a larger interval.`}
        </div>
      )}
    </div>
  )
}

/**
 * Appearance and chart links on right-click, where platforms put them.
 *
 * The same controls the rail button opens, not a second copy: one set of
 * inputs reached two ways cannot drift out of step with itself.
 *
 * Opened at the pointer and clamped to the *window*, by `Floating`. It used
 * to be clamped to the pane, which cannot work: the pane hides its overflow,
 * and a stacked reference chart is shorter than this menu is tall, so the
 * last section -- the one that links the charts back together -- had nowhere
 * inside the pane to be.
 */
function ChartContextMenu() {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)
  const paneRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    const pane = paneRef.current?.parentElement
    if (!pane) return

    const open = (event: MouseEvent) => {
      // A text field keeps its own menu -- paste, spelling -- which the
      // chart's settings would otherwise take the place of.
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return
      }
      event.preventDefault()
      setAt({ x: event.clientX, y: event.clientY })
    }

    pane.addEventListener('contextmenu', open)
    return () => pane.removeEventListener('contextmenu', open)
  }, [])

  const close = useCallback(() => setAt(null), [])

  return (
    <div ref={paneRef} className="pointer-events-none absolute inset-0 z-40">
      {/*
        The panel is named differently from the button that opens it. Sharing
        one name made two elements answer to "Chart appearance" whenever the
        panel was open -- ambiguous to a screen reader, and to any test
        reaching for either of them by name.
      */}
      {at && (
        <Floating at={at} onClose={close} label="Chart appearance and links" className="w-44">
          <ChartSettingsBody />
        </Floating>
      )}
    </div>
  )
}
