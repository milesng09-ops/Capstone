/** One instrument's chart: candles, overlays and a legend laid over them. */

import { useCallback, useMemo, useState } from 'react'
import { Maximize2 } from 'lucide-react'

import { ChartOverlay } from '@/components/chart/ChartOverlay'
import { DrawingActions } from '@/components/chart/DrawingActions'
import { useChartInstance } from '@/components/chart/useChartInstance'
import { Badge, Button, Spinner } from '@/components/ui/primitives'
import { useBacktestResult } from '@/hooks/useBacktest'
import { useChartRange } from '@/hooks/useChartRange'
import { useBars, useIct } from '@/hooks/useMarketData'
import {
  collectEvidence,
  evidenceWindow,
  findMatch,
  findTrade,
  tradesForSymbol,
} from '@/lib/trades'
import { useChartedSymbols, useWorkspace } from '@/store/workspace'
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
import { directionClass, formatCompact, formatPercent, formatPrice } from '@/utils/format'

interface Props {
  symbol: SymbolKey
  isPrimary: boolean
  precision?: number
  className?: string
}

export function ChartPanel({ symbol, isPrimary, precision = 2, className }: Props) {
  const range = useChartRange()
  const interval = useWorkspace((state) => state.interval)
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

  const barsQuery = useBars(symbol, interval, range.from, range.to)
  const ictQuery = useIct(symbol, interval, range.from, range.to, references, ictSettings)

  const candles = useMemo(() => barsQuery.data?.bars ?? [], [barsQuery.data])
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
    precision,
    onHoverBar: setHovered,
    settings: chartSettings,
  })

  const handleCreate = useCallback(
    (drawing: DrawingDraft) => {
      addDrawing({ ...drawing, id: crypto.randomUUID(), createdAt: Date.now() })
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

  const last = candles.at(-1)
  const first = candles[0]
  const changePercent =
    last && first && first.open ? ((last.close - first.open) / first.open) * 100 : 0

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

      {/*
       * The legend sits over the candles instead of in a title bar above them.
       * In a stack of three charts, 32px of header each is a tenth of the
       * screen spent on labels -- and the top-left corner of a price pane is
       * reliably empty, which is why charting platforms all put it there.
       */}
      <div className="chart-legend pointer-events-none absolute left-2 top-1.5 z-20 flex flex-col gap-0.5">
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-semibold tracking-tight">{symbol}</span>
          <span className="text-muted-foreground">{INTERVAL_LABELS[interval]}</span>

          {last && (
            <span className={cn('numeric', directionClass(changePercent))}>
              {formatPrice(last.close, precision)}
              <span className="ml-1">{formatPercent(changePercent)}</span>
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
                  : `Source: ${barsQuery.data?.provider ?? 'unknown'}`
            }
          >
            {QUALITY_LABELS[quality] ?? quality}
          </Badge>

          {(barsQuery.isFetching || ictQuery.isFetching) && (
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
          selectedTradeId={selectedTradeId}
          evidence={evidence}
          tool={tool}
          drawingColor={drawingColor}
          drawingWidth={drawingWidth}
          magnet={magnet}
          selectedDrawingId={selectedDrawingId}
          snapToSwings={snapToSwings}
          allowSelection={isPrimary}
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
