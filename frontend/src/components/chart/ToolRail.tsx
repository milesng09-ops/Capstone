/**
 * Drawing tools, in a rail down the left edge of the charts.
 *
 * They sit here rather than in the top bar because they are a different kind
 * of control: a tool is *held* while you work on the candles, not set once
 * like a symbol or an interval. Putting them along the edge they act on keeps
 * the pointer's round trip short, and frees the top bar to be only about what
 * is charted -- which is how every charting terminal ends up laying this out.
 *
 * The rail is 40px wide, so everything in it is an icon. Every button carries
 * a title with its keyboard-free explanation, since an icon alone never says
 * what "snap" or "zone" means to someone opening this for the first time.
 */

import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BoxSelect,
  CalendarRange,
  Magnet,
  Minus,
  MousePointer2,
  Palette,
  Redo2,
  Slash,
  Square,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/primitives'
import { useWorkspace } from '@/store/workspace'
import {
  DRAWING_COLORS,
  TOOL_HINTS,
  TOOL_LABELS,
  type ToolMode,
} from '@/types/drawing'
import { cn } from '@/utils/cn'

const TOOL_ICONS: Record<ToolMode, LucideIcon> = {
  cursor: MousePointer2,
  select: BoxSelect,
  window: CalendarRange,
  trendline: Slash,
  horizontal: Minus,
  rectangle: Square,
}

/**
 * Pointer, then the two ranges a backtest is made of, then the shapes.
 *
 * The ranges sit next to each other because they are read as a pair: what to
 * look for, and where to look for it.
 */
const TOOL_ORDER: ToolMode[] = [
  'cursor',
  'select',
  'window',
  'trendline',
  'horizontal',
  'rectangle',
]

export function ToolRail({ footer }: { footer?: ReactNode }) {
  const tool = useWorkspace((state) => state.tool)
  const drawingColor = useWorkspace((state) => state.drawingColor)
  const snapToSwings = useWorkspace((state) => state.snapToSwings)
  const showSwings = useWorkspace((state) => state.ict.showSwings)
  const drawingCount = useWorkspace((state) => state.drawings.length)

  const setTool = useWorkspace((state) => state.setTool)
  const setDrawingColor = useWorkspace((state) => state.setDrawingColor)
  const setSnapToSwings = useWorkspace((state) => state.setSnapToSwings)
  const clearDrawings = useWorkspace((state) => state.clearDrawings)

  return (
    <nav
      aria-label="Drawing tools"
      className="panel flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-border py-1.5"
    >
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
            <Icon size={15} />
          </Button>
        )
      })}

      <RailDivider />

      <ColorPicker value={drawingColor} onChange={setDrawingColor} />

      {/*
        Snapping only reaches swing points the chart is drawing, so with them
        hidden -- which is the default -- this control has nothing to act on.
        Left merely lit it was a switch that visibly did nothing; disabled and
        explained, it says what to turn on to make it work.
      */}
      <Button
        size="icon"
        variant="toolbar"
        data-active={snapToSwings && showSwings}
        disabled={!showSwings}
        onClick={() => setSnapToSwings(!snapToSwings)}
        title={
          showSwings
            ? 'Snap drawings to nearby swing points'
            : 'Snapping needs the swing points on screen — turn them on under Analysis'
        }
        aria-label="Snap to swing points"
        aria-pressed={snapToSwings && showSwings}
      >
        <Magnet size={15} />
      </Button>

      <RailDivider />

      <Button
        size="icon"
        variant="toolbar"
        onClick={() => clearDrawings()}
        disabled={drawingCount === 0}
        title="Remove every drawing"
        aria-label="Clear drawings"
      >
        <Trash2 size={15} />
      </Button>

      <HistoryButtons />

      {/*
       * On a phone this rail is the only one, so it also carries the way into
       * the side panels. They go at the bottom, behind a divider: the tools
       * above are what the rail is *for*, and pushing them down to make room
       * for navigation would cost the drawing buttons their muscle memory.
       */}
      {footer && (
        <>
          <RailDivider />
          {footer}
        </>
      )}
    </nav>
  )
}

function RailDivider() {
  return <span className="my-1 h-px w-5 shrink-0 bg-border" />
}

/** Undo and redo over the drawing history the store keeps. */
function HistoryButtons() {
  const undo = useWorkspace((state) => state.undoDrawings)
  const redo = useWorkspace((state) => state.redoDrawings)
  const canUndo = useWorkspace((state) => state.past.length > 0)
  const canRedo = useWorkspace((state) => state.future.length > 0)

  return (
    <>
      <Button
        size="icon"
        variant="toolbar"
        onClick={undo}
        disabled={!canUndo}
        title="Undo the last change to the drawings"
        aria-label="Undo"
      >
        <Undo2 size={15} />
      </Button>
      <Button
        size="icon"
        variant="toolbar"
        onClick={redo}
        disabled={!canRedo}
        title="Redo the change that was undone"
        aria-label="Redo"
      >
        <Redo2 size={15} />
      </Button>
    </>
  )
}

/**
 * The drawing colour, as a swatch that opens a flyout.
 *
 * Six swatches stacked in a 40px rail would be a third of its height spent on
 * a setting that is changed rarely, so the rail shows only the current colour
 * and the rest appear beside it on demand.
 */
function ColorPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (color: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Close on an outside press or on Escape, the two ways anyone expects to
  // dismiss a popover without choosing from it.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="icon"
        variant="toolbar"
        onClick={() => setOpen((current) => !current)}
        title="Colour used by the next drawing"
        aria-label="Drawing colour"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="relative">
          <Palette size={15} />
          <span
            className="absolute -bottom-1.5 left-0 h-1 w-full rounded-full"
            style={{ backgroundColor: value }}
          />
        </span>
      </Button>

      {open && (
        <div
          role="group"
          aria-label="Drawing colour"
          className="absolute left-full top-0 z-40 ml-1 grid grid-cols-3 gap-1 rounded border border-border bg-[hsl(var(--popover))] p-1.5 shadow-lg"
        >
          {DRAWING_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Use colour ${color}`}
              aria-pressed={color === value}
              onClick={() => {
                onChange(color)
                setOpen(false)
              }}
              style={{ backgroundColor: color }}
              className={cn(
                'h-4 w-4 rounded-full border transition-transform',
                color === value
                  ? 'scale-110 border-foreground'
                  : 'border-transparent hover:scale-110',
              )}
            />
          ))}
        </div>
      )}
    </div>
  )
}
