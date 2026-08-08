/** Market selection on the left, drawing tools on the right. */

import {
  BoxSelect,
  Magnet,
  Maximize2,
  Minus,
  MousePointer2,
  Slash,
  Square,
  Trash2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/primitives'
import { SegmentedControl } from '@/components/ui/fields'
import { RANGE_PRESETS, useWorkspace, type RangeDays } from '@/store/workspace'
import {
  DRAWING_COLORS,
  TOOL_HINTS,
  TOOL_LABELS,
  type ToolMode,
} from '@/types/drawing'
import { INTERVAL_LABELS, INTERVALS, SYMBOLS, type Interval, type SymbolKey } from '@/types/market'
import { cn } from '@/utils/cn'

const TOOL_ICONS: Record<ToolMode, LucideIcon> = {
  cursor: MousePointer2,
  select: BoxSelect,
  trendline: Slash,
  horizontal: Minus,
  rectangle: Square,
}

const TOOL_ORDER: ToolMode[] = ['cursor', 'select', 'trendline', 'horizontal', 'rectangle']

export function ChartToolbar({ onFit }: { onFit?: () => void }) {
  const primarySymbol = useWorkspace((state) => state.primarySymbol)
  const compareSymbols = useWorkspace((state) => state.compareSymbols)
  const interval = useWorkspace((state) => state.interval)
  const rangeDays = useWorkspace((state) => state.rangeDays)
  const tool = useWorkspace((state) => state.tool)
  const drawingColor = useWorkspace((state) => state.drawingColor)
  const snapToSwings = useWorkspace((state) => state.snapToSwings)
  const drawingCount = useWorkspace((state) => state.drawings.length)

  const setPrimarySymbol = useWorkspace((state) => state.setPrimarySymbol)
  const toggleCompareSymbol = useWorkspace((state) => state.toggleCompareSymbol)
  const setInterval = useWorkspace((state) => state.setInterval)
  const setRangeDays = useWorkspace((state) => state.setRangeDays)
  const setTool = useWorkspace((state) => state.setTool)
  const setDrawingColor = useWorkspace((state) => state.setDrawingColor)
  const setSnapToSwings = useWorkspace((state) => state.setSnapToSwings)
  const clearDrawings = useWorkspace((state) => state.clearDrawings)

  return (
    <div className="panel flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg px-3 py-2">
      {/* ---- market ---- */}
      <div className="flex items-center gap-2">
        <span className="label-caps">Chart</span>
        <SegmentedControl<SymbolKey>
          value={primarySymbol}
          options={SYMBOLS.map((symbol) => ({ value: symbol, label: symbol }))}
          onChange={setPrimarySymbol}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="label-caps" title="Correlated markets charted alongside, for SMT divergence">
          Compare
        </span>
        <div className="flex items-center gap-1">
          {SYMBOLS.filter((symbol) => symbol !== primarySymbol).map((symbol) => {
            const active = compareSymbols.includes(symbol)
            return (
              <Button
                key={symbol}
                size="sm"
                variant="toolbar"
                data-active={active}
                onClick={() => toggleCompareSymbol(symbol)}
                title={
                  active
                    ? `Stop comparing ${primarySymbol} against ${symbol}`
                    : `Chart ${symbol} alongside and check for divergence`
                }
              >
                {symbol}
              </Button>
            )
          })}
        </div>
      </div>

      <div className="flex items-center gap-2">
        <span className="label-caps">Interval</span>
        <SegmentedControl<Interval>
          value={interval}
          options={INTERVALS.map((item) => ({ value: item, label: INTERVAL_LABELS[item] }))}
          onChange={setInterval}
        />
      </div>

      <div className="flex items-center gap-2">
        <span className="label-caps">History</span>
        <SegmentedControl<string>
          value={String(rangeDays)}
          options={RANGE_PRESETS.map((days) => ({
            value: String(days),
            label: days >= 365 ? `${days / 365}y` : `${days}d`,
          }))}
          onChange={(value) => setRangeDays(Number(value) as RangeDays)}
        />
      </div>

      {/* ---- tools ---- */}
      <div className="ml-auto flex items-center gap-2">
        <div className="flex items-center gap-0.5 rounded-md border border-border bg-[hsl(var(--panel-raised))] p-0.5">
          {TOOL_ORDER.map((mode) => {
            const Icon = TOOL_ICONS[mode]
            return (
              <Button
                key={mode}
                size="icon"
                variant="toolbar"
                data-active={tool === mode}
                onClick={() => setTool(mode)}
                title={`${TOOL_LABELS[mode]} - ${TOOL_HINTS[mode]}`}
                aria-label={TOOL_LABELS[mode]}
                aria-pressed={tool === mode}
              >
                <Icon size={14} />
              </Button>
            )
          })}
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Drawing colour">
          {DRAWING_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Use colour ${color}`}
              aria-pressed={color === drawingColor}
              onClick={() => setDrawingColor(color)}
              style={{ backgroundColor: color }}
              className={cn(
                'h-4 w-4 rounded-full border transition-transform',
                color === drawingColor
                  ? 'scale-110 border-foreground'
                  : 'border-transparent hover:scale-105',
              )}
            />
          ))}
        </div>

        <Button
          size="icon"
          variant="toolbar"
          data-active={snapToSwings}
          onClick={() => setSnapToSwings(!snapToSwings)}
          title="Snap drawings to nearby swing points"
          aria-label="Snap to swing points"
          aria-pressed={snapToSwings}
        >
          <Magnet size={14} />
        </Button>

        <Button
          size="icon"
          variant="toolbar"
          onClick={() => clearDrawings()}
          disabled={drawingCount === 0}
          title="Remove every drawing"
          aria-label="Clear drawings"
        >
          <Trash2 size={14} />
        </Button>

        {onFit && (
          <Button
            size="icon"
            variant="toolbar"
            onClick={onFit}
            title="Fit all candles in view"
            aria-label="Fit content"
          >
            <Maximize2 size={14} />
          </Button>
        )}
      </div>
    </div>
  )
}
