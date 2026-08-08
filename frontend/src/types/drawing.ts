/**
 * Hand-drawn chart annotations.
 *
 * Lightweight Charts ships no drawing tools, so these are ours. Every drawing
 * is stored in **market coordinates** -- a time in Unix milliseconds and a
 * price -- never in pixels. That is what lets a level drawn on the 1-hour
 * chart stay on the same candle after zooming, panning or switching to the
 * 4-hour: the anchor is the market, not the screen.
 */

export type DrawingKind = 'trendline' | 'horizontal' | 'rectangle'

/** Active pointer mode. `cursor` hands the mouse back to the chart. */
export type ToolMode = 'cursor' | 'select' | DrawingKind

export interface DrawingPoint {
  /** Unix milliseconds, snapped to a candle open. */
  time: number
  price: number
}

interface DrawingBase {
  id: string
  /** Drawings belong to one chart; NQ annotations do not show up on ES. */
  symbol: string
  color: string
  createdAt: number
}

/** A line between two points -- typically two swing points. */
export interface TrendlineDrawing extends DrawingBase {
  kind: 'trendline'
  from: DrawingPoint
  to: DrawingPoint
}

/** A price level running the full width of the chart. */
export interface HorizontalDrawing extends DrawingBase {
  kind: 'horizontal'
  price: number
}

/** A zone: a time range crossed with a price range. */
export interface RectangleDrawing extends DrawingBase {
  kind: 'rectangle'
  from: DrawingPoint
  to: DrawingPoint
}

export type Drawing = TrendlineDrawing | HorizontalDrawing | RectangleDrawing

/**
 * A drawing before it has been given an id.
 *
 * `Omit` over a union collapses it to the keys the members share, which would
 * throw away `price`, `from` and `to`. Distributing the omit across each
 * member keeps every variant intact.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type DrawingDraft = DistributiveOmit<Drawing, 'id' | 'createdAt'>

export const TOOL_LABELS: Record<ToolMode, string> = {
  cursor: 'Cursor',
  select: 'Select range',
  trendline: 'Trend line',
  horizontal: 'Level',
  rectangle: 'Zone',
}

export const TOOL_HINTS: Record<ToolMode, string> = {
  cursor: 'Pan and zoom the chart.',
  select: 'Drag across the candles that form the setup you want to test.',
  trendline: 'Drag from one point to another. Snaps to nearby swing points.',
  horizontal: 'Click to place a price level across the chart.',
  rectangle: 'Drag to mark a zone.',
}

/** Palette offered when drawing. Kept small so charts stay readable. */
export const DRAWING_COLORS = [
  '#818cf8',
  '#22d3ee',
  '#f59e0b',
  '#f43f5e',
  '#34d399',
  '#e2e8f0',
] as const

export const DEFAULT_DRAWING_COLOR = DRAWING_COLORS[0]

/** True for the tools that need a press-drag-release gesture. */
export function isDragTool(tool: ToolMode): boolean {
  return tool === 'trendline' || tool === 'rectangle' || tool === 'select'
}

/** The two corners of a rectangle or the endpoints of a line, normalised. */
export function drawingBounds(drawing: Drawing): {
  startTime: number
  endTime: number
  low: number
  high: number
} {
  if (drawing.kind === 'horizontal') {
    return {
      startTime: Number.NEGATIVE_INFINITY,
      endTime: Number.POSITIVE_INFINITY,
      low: drawing.price,
      high: drawing.price,
    }
  }
  return {
    startTime: Math.min(drawing.from.time, drawing.to.time),
    endTime: Math.max(drawing.from.time, drawing.to.time),
    low: Math.min(drawing.from.price, drawing.to.price),
    high: Math.max(drawing.from.price, drawing.to.price),
  }
}
