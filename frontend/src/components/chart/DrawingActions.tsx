/**
 * What you can do to the drawing you just clicked, floating next to it.
 *
 * Selecting a shape and pressing Delete already worked, but a keystroke is
 * not an affordance: nothing on screen said the shape could be removed, so
 * the honest reading of "I can't erase them" is that there was no way to find
 * out. A small bar that appears against the selection says it plainly, and is
 * how every charting platform answers the same question.
 *
 * It tracks the drawing rather than the pointer -- anchored above the shape
 * and re-placed on every pan and zoom through the chart's own notifications,
 * so it stays where the shape is instead of where the shape used to be.
 */

import { useEffect, useState } from 'react'
import { SeparatorHorizontal, Trash2 } from 'lucide-react'

import type { ChartHandle } from '@/components/chart/useChartInstance'
import { Button } from '@/components/ui/primitives'
import { useWorkspace } from '@/store/workspace'
import {
  DRAWING_COLORS,
  DRAWING_WIDTHS,
  TOOL_LABELS,
  type Drawing,
} from '@/types/drawing'
import { cn } from '@/utils/cn'

/** Roughly the bar's own size, used to keep it inside the pane. */
const BAR_WIDTH_PX = 340
const BAR_HEIGHT_PX = 26

interface Props {
  symbol: string
  handle: ChartHandle
  /** Only this pane's drawings; a selection on another chart is not ours. */
  drawings: Drawing[]
}

interface Anchor {
  x: number
  y: number
}

export function DrawingActions({ handle, drawings }: Props) {
  const selectedId = useWorkspace((state) => state.selectedDrawingId)
  const removeDrawing = useWorkspace((state) => state.removeDrawing)
  const updateDrawing = useWorkspace((state) => state.updateDrawing)

  const drawing = drawings.find((item) => item.id === selectedId) ?? null
  const [anchor, setAnchor] = useState<Anchor | null>(null)
  const [pane, setPane] = useState<HTMLElement | null>(null)

  useEffect(() => {
    if (!drawing || !pane) {
      setAnchor(null)
      return
    }

    const place = () => {
      const point = anchorFor(drawing, handle)
      if (!point) {
        setAnchor(null)
        return
      }

      const width = pane.clientWidth
      const height = pane.clientHeight
      setAnchor({
        x: clamp(point.x - BAR_WIDTH_PX / 2, 4, Math.max(4, width - BAR_WIDTH_PX - 4)),
        // Above the shape by default; below it when the shape is near the top
        // of the pane and there is no room above.
        y:
          point.y - BAR_HEIGHT_PX - 8 < 4
            ? clamp(point.y + 10, 4, Math.max(4, height - BAR_HEIGHT_PX - 4))
            : point.y - BAR_HEIGHT_PX - 8,
      })
    }

    place()
    // The chart notifies imperatively on pan, zoom and resize, which is what
    // keeps the bar attached without re-rendering the tree on every frame.
    return handle.subscribe(place)
  }, [drawing, handle, pane])

  if (!drawing) return null

  return (
    <div
      ref={setPane}
      className="pointer-events-none absolute inset-0 z-30"
      aria-hidden={anchor == null}
    >
      {anchor && (
        <div
          role="toolbar"
          aria-label={`${TOOL_LABELS[drawing.kind]} actions`}
          className="pointer-events-auto absolute flex items-center gap-1 rounded border border-border bg-[hsl(var(--popover))] px-1.5 py-1 shadow-lg"
          style={{ left: anchor.x, top: anchor.y }}
        >
          <span className="label-caps pr-0.5">{TOOL_LABELS[drawing.kind]}</span>

          <span className="h-3.5 w-px bg-border" />

          {DRAWING_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Recolour to ${color}`}
              aria-pressed={color === drawing.color}
              onClick={() => updateDrawing(drawing.id, { color })}
              style={{ backgroundColor: color }}
              className={cn(
                'h-3 w-3 rounded-full border transition-transform',
                color === drawing.color
                  ? 'scale-125 border-foreground'
                  : 'border-transparent hover:scale-125',
              )}
            />
          ))}

          {drawing.kind === 'text' && (
            <>
              <span className="h-3.5 w-px bg-border" />
              {/*
                * The note is edited where it is selected rather than in a
                * dialog: a caption is a few words, and sending someone to
                * another surface to change four of them is the slower path.
                */}
              <input
                value={drawing.text}
                onChange={(event) =>
                  updateDrawing(drawing.id, { text: event.target.value })
                }
                aria-label="Note text"
                placeholder="Note"
                className="h-5 w-28 rounded border border-input bg-[hsl(var(--panel-raised))] px-1 text-2xs outline-none focus:border-primary/60"
              />
            </>
          )}

          <span className="h-3.5 w-px bg-border" />

          {/*
            * Thickness, as a set of increasingly heavy strokes rather than a
            * number: the choice is visual, so the control shows the outcome.
            */}
          {DRAWING_WIDTHS.map((value) => (
            <button
              key={value}
              type="button"
              aria-label={`Line width ${value}`}
              aria-pressed={value === drawing.width}
              onClick={() => updateDrawing(drawing.id, { width: value })}
              className={cn(
                'flex h-4 w-4 items-center justify-center rounded transition-colors',
                value === drawing.width
                  ? 'bg-[hsl(var(--panel-raised))]'
                  : 'hover:bg-[hsl(var(--panel-raised))]',
              )}
            >
              <span
                className="w-2.5 rounded-full bg-current"
                style={{ height: value }}
              />
            </button>
          ))}

          {drawing.kind === 'rectangle' && (
            <>
              <span className="h-3.5 w-px bg-border" />
              <button
                type="button"
                aria-label="Midpoint line"
                aria-pressed={Boolean(drawing.midline)}
                title="Show the line halfway up the zone -- the level the midpoint itself is"
                onClick={() =>
                  updateDrawing(drawing.id, { midline: !drawing.midline })
                }
                className={cn(
                  'flex h-4 w-5 items-center justify-center rounded transition-colors',
                  drawing.midline
                    ? 'bg-[hsl(var(--panel-raised))] text-foreground'
                    : 'text-muted-foreground hover:bg-[hsl(var(--panel-raised))]',
                )}
              >
                <SeparatorHorizontal size={11} />
              </button>
            </>
          )}

          <span className="h-3.5 w-px bg-border" />

          <Button
            size="icon"
            variant="ghost"
            className="h-5 w-5 text-muted-foreground hover:text-bear"
            onClick={() => removeDrawing(drawing.id)}
            title="Delete this drawing (Del)"
            aria-label="Delete drawing"
          >
            <Trash2 size={12} />
          </Button>
        </div>
      )}
    </div>
  )
}

/**
 * Where the bar hangs from: the middle of the shape's top edge.
 *
 * A level has no ends -- it runs the full width of the pane -- so it is
 * anchored a short way in from the left, next to the price label that is
 * already painted there.
 */
function anchorFor(drawing: Drawing, handle: ChartHandle): Anchor | null {
  if (drawing.kind === 'horizontal') {
    const y = handle.priceToY(drawing.price)
    return y == null ? null : { x: BAR_WIDTH_PX / 2 + 8, y }
  }

  if (drawing.kind === 'text') {
    const x = handle.timeToXFree(drawing.at.time)
    const y = handle.priceToY(drawing.at.price)
    return x == null || y == null ? null : { x, y }
  }

  if (drawing.kind === 'horizontal_ray') {
    const x = handle.timeToXFree(drawing.from.time)
    const y = handle.priceToY(drawing.from.price)
    return x == null || y == null ? null : { x, y }
  }

  if (drawing.kind === 'vertical') {
    // The mirror of a level: it has a time and no price, so the toolbar sits
    // at the top of the line rather than beside it.
    const x = handle.timeToXFree(drawing.time)
    return x == null ? null : { x, y: 8 }
  }

  const x1 = handle.timeToXFree(drawing.from.time)
  const x2 = handle.timeToXFree(drawing.to.time)
  const y1 = handle.priceToY(drawing.from.price)
  const y2 = handle.priceToY(drawing.to.price)
  if (x1 == null || x2 == null || y1 == null || y2 == null) return null

  return { x: (x1 + x2) / 2, y: Math.min(y1, y2) }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}
