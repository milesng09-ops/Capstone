/**
 * Correlated charts, stacked.
 *
 * They are stacked vertically rather than tiled because SMT divergence is read
 * by looking straight down a vertical line: the same candle on NQ and on ES,
 * one above the other. `chartSync` keeps the crosshair and the scroll position
 * locked so that line means the same thing on every panel.
 *
 * The primary chart gets more height -- it is the one you select on and
 * backtest -- while the comparison charts only need enough to see whether a
 * high was taken.
 */

import { ChartPanel } from '@/components/chart/ChartPanel'
import { ErrorBoundary } from '@/components/ui/ErrorBoundary'
import { useChartedSymbols, useWorkspace } from '@/store/workspace'
import { cn } from '@/utils/cn'

/** Price precision per instrument; YM trades in whole points. */
const PRECISION: Record<string, number> = { ES: 2, NQ: 2, YM: 0 }

export function ChartGrid() {
  const symbols = useChartedSymbols()
  const primary = useWorkspace((state) => state.primarySymbol)

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {symbols.map((symbol) => (
        <div
          key={symbol}
          className={cn('flex min-h-0', symbol === primary ? 'flex-[3]' : 'flex-[2]')}
        >
          <ErrorBoundary label={`The ${symbol} chart`}>
            <ChartPanel
              symbol={symbol}
              isPrimary={symbol === primary}
              precision={PRECISION[symbol] ?? 2}
              className="flex-1"
            />
          </ErrorBoundary>
        </div>
      ))}
    </div>
  )
}
