/**
 * The charted markets, arranged.
 *
 * `stacked` is the default and the reason the workspace exists: SMT divergence
 * is read by looking straight down a vertical line -- the same candle on NQ
 * and on ES, one above the other. Stacking is what makes the comparison
 * sightable at all, and `chartSync` is what makes that line mean the same
 * moment on every pane, by locking the crosshair and the scroll together.
 *
 * Those two links start *off*: panning or zooming one chart used to drag
 * every other chart with it, so there was no way to look closely at one
 * market on its own. Each pane now moves by itself, and locking them is a
 * switch in the chart's right-click menu -- see `DEFAULT_CHART_SYNC`.
 *
 * The other arrangements answer a different question. `columns` gives every
 * chart the full height of the screen, which is what you want when you are
 * reading the shape of one market rather than comparing two. `grid` puts the
 * primary across the top with the references beneath it, for a wide monitor.
 *
 * Whichever is chosen, the primary chart is the one you select on and backtest,
 * so it gets the larger share -- and the divider between it and the references
 * is draggable, because how much room that is depends on the screen and on
 * what you are looking for.
 */

import { useState } from 'react'

import { ChartPanel } from '@/components/chart/ChartPanel'
import { Splitter } from '@/components/layout/Splitter'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { CRAMPED_QUERY, useMediaQuery } from '@/hooks/useMediaQuery'
import { useChartedSymbols, useWorkspace } from '@/store/workspace'
import type { SymbolKey } from '@/types/market'
import { cn } from '@/utils/cn'

/** Price precision per instrument; YM trades in whole points. */
const PRECISION: Record<string, number> = { ES: 2, NQ: 2, YM: 0 }

/** Share of the pane given to the primary chart before anyone drags it. */
const DEFAULT_PRIMARY_RATIO = 0.6

export function ChartGrid() {
  const symbols = useChartedSymbols()
  const primary = useWorkspace((state) => state.primarySymbol)
  const chosenLayout = useWorkspace((state) => state.chartLayout)

  /**
   * Side by side stops being an arrangement and starts being a pair of
   * slivers, so below the breakpoint everything stacks whatever the toolbar
   * says. Derived rather than written back to the store: the choice is still
   * the user's, it simply cannot be honoured at this width, and widening the
   * window is enough to have it again.
   */
  const cramped = useMediaQuery(CRAMPED_QUERY)
  const layout = cramped ? 'stacked' : chosenLayout

  // Held here rather than in the store: the split is a per-session adjustment
  // to the layout preset, not a preference worth restoring on a cold start.
  const [ratio, setRatio] = useState(DEFAULT_PRIMARY_RATIO)

  const references = symbols.filter((symbol) => symbol !== primary)

  // One chart needs no arrangement at all.
  if (references.length === 0) {
    return (
      <div className="min-h-0 flex-1">
        <Pane symbol={primary} isPrimary />
      </div>
    )
  }

  // The grid is fixed rather than draggable: with the primary spanning the top
  // row there is no single divider to drag that would not also skew the pair
  // underneath it out of alignment with each other.
  if (layout === 'grid') {
    return (
      <div className="grid min-h-0 flex-1 auto-rows-fr grid-cols-2 gap-px bg-border">
        <div className={cn('min-h-0', references.length > 1 && 'col-span-2')}>
          <Pane symbol={primary} isPrimary />
        </div>
        {references.map((symbol) => (
          <div key={symbol} className="min-h-0">
            <Pane symbol={symbol} />
          </div>
        ))}
      </div>
    )
  }

  const row = layout === 'columns'

  return (
    <div className={cn('flex min-h-0 flex-1', row ? 'flex-row' : 'flex-col')}>
      <div className="min-h-0 min-w-0" style={{ flex: `${ratio} 1 0%` }}>
        <Pane symbol={primary} isPrimary />
      </div>

      <Splitter
        direction={row ? 'row' : 'column'}
        ratio={ratio}
        onRatioChange={setRatio}
        label="Resize the primary chart"
      />

      <div
        className={cn(
          'flex min-h-0 min-w-0 gap-px bg-border',
          row ? 'flex-row' : 'flex-col',
        )}
        style={{ flex: `${1 - ratio} 1 0%` }}
      >
        {references.map((symbol) => (
          <div key={symbol} className="min-h-0 min-w-0 flex-1">
            <Pane symbol={symbol} />
          </div>
        ))}
      </div>
    </div>
  )
}

function Pane({ symbol, isPrimary = false }: { symbol: SymbolKey; isPrimary?: boolean }) {
  return (
    <ErrorBoundary label={`The ${symbol} chart`}>
      <ChartPanel
        symbol={symbol}
        isPrimary={isPrimary}
        precision={PRECISION[symbol] ?? 2}
        className="h-full"
      />
    </ErrorBoundary>
  )
}
