/** One instrument's chart: candles, overlays and a compact readout. */

import { useCallback, useMemo, useState } from 'react'

import { ChartOverlay } from '@/components/chart/ChartOverlay'
import { useChartInstance } from '@/components/chart/useChartInstance'
import { Badge, Spinner } from '@/components/ui/primitives'
import { useChartRange } from '@/hooks/useChartRange'
import { useBars, useIct } from '@/hooks/useMarketData'
import { useChartedSymbols, useWorkspace } from '@/store/workspace'
import type { DrawingDraft } from '@/types/drawing'
import {
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
  const allDrawings = useWorkspace((state) => state.drawings)
  const selectedDrawingId = useWorkspace((state) => state.selectedDrawingId)
  const snapToSwings = useWorkspace((state) => state.snapToSwings)
  const selection = useWorkspace((state) => state.selection)
  const addDrawing = useWorkspace((state) => state.addDrawing)
  const setSelection = useWorkspace((state) => state.setSelection)
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

  const [hovered, setHovered] = useState<Candle | null>(null)

  const { containerRef, handle, ready } = useChartInstance({
    id: `chart-${symbol}`,
    candles,
    precision,
    onHoverBar: setHovered,
  })

  const handleCreate = useCallback(
    (drawing: DrawingDraft) => {
      addDrawing({ ...drawing, id: crypto.randomUUID(), createdAt: Date.now() })
    },
    [addDrawing],
  )

  const handleGestureComplete = useCallback(() => {
    // Drop back to the cursor so the next drag pans the chart, matching how
    // every charting platform behaves after a shape is placed.
    setTool('cursor')
  }, [setTool])

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
        'panel relative flex min-h-0 flex-col overflow-hidden rounded-lg',
        isPrimary && 'ring-1 ring-primary/30',
        className,
      )}
    >
      <header className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2.5">
        <span className="text-xs font-semibold tracking-tight">{symbol}</span>
        {isPrimary && (
          <Badge tone="accent" title="Selections and backtests run on this chart">
            Primary
          </Badge>
        )}

        {last && (
          <span className={cn('numeric text-xs', directionClass(changePercent))}>
            {formatPrice(last.close, precision)}
            <span className="ml-1.5 text-2xs">{formatPercent(changePercent)}</span>
          </span>
        )}

        <div className="ml-auto flex items-center gap-1.5">
          {(barsQuery.isFetching || ictQuery.isFetching) && (
            <Spinner className="text-muted-foreground" />
          )}
          <Badge
            tone={UNRELIABLE_QUALITIES.has(quality) ? 'warn' : 'neutral'}
            title={
              quality === 'demo'
                ? 'Synthetic data generated from a fixed seed. Not real market prices.'
                : quality === 'partial'
                  ? barsQuery.data?.fallback_reason ??
                    'Part of this window could not be fetched. Bars may be missing.'
                  : `Source: ${barsQuery.data?.provider ?? 'unknown'}`
            }
          >
            {QUALITY_LABELS[quality] ?? quality}
          </Badge>
          <span className="numeric text-2xs text-muted-foreground">
            {formatCompact(candles.length)} bars
          </span>
        </div>
      </header>

      {readout && (
        <div className="pointer-events-none absolute left-2.5 top-10 z-20 flex gap-2.5 text-2xs">
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
        </div>
      )}

      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />

        {ready && candles.length > 0 && (
          <ChartOverlay
            symbol={symbol}
            handle={handle}
            candles={candles}
            ict={ictQuery.data}
            ictSettings={ictSettings}
            drawings={drawings}
            selection={selection?.symbol === symbol ? selection : null}
            tool={tool}
            drawingColor={drawingColor}
            selectedDrawingId={selectedDrawingId}
            snapToSwings={snapToSwings}
            allowSelection={isPrimary}
            onCreateDrawing={handleCreate}
            onSelectionChange={setSelection}
            onGestureComplete={handleGestureComplete}
          />
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
            No candles for {symbol} in this range. Try a longer history or a larger interval.
          </div>
        )}
      </div>
    </div>
  )
}
