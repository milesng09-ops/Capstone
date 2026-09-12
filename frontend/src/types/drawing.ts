/**
 * Hand-drawn chart annotations.
 *
 * Lightweight Charts ships no drawing tools, so these are ours. Every drawing
 * is stored in **market coordinates** -- a time in Unix milliseconds and a
 * price -- never in pixels. That is what lets a level drawn on the 1-hour
 * chart stay on the same candle after zooming, panning or switching to the
 * 4-hour: the anchor is the market, not the screen.
 */

export type DrawingKind =
  | 'trendline'
  | 'horizontal'
  | 'rectangle'
  | 'ray'
  | 'vertical'
  | 'arrow'
  | 'horizontal_ray'

/**
 * Active pointer mode. `cursor` hands the mouse back to the chart.
 *
 * `select` and `window` are not drawings: they mark out the two ranges a
 * backtest is made of -- the setup to look for, and the stretch of history to
 * look for it in -- and both only mean anything on the primary chart.
 */
export type ToolMode = 'cursor' | 'select' | 'window' | DrawingKind

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
  /** Stroke thickness in pixels. Selection and hover add to it rather than
   *  replacing it, so a deliberately hairline level stays hairline. */
  width: number
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
  /**
   * Draw the line halfway up the zone.
   *
   * Not decoration: the midpoint of an imbalance is a level in its own right
   * -- consequent encroachment -- and is traded as one, which is why the
   * backend already computes it for every fair value gap it finds.
   */
  midline?: boolean
}

/**
 * A line from one point through another, continuing to the right edge.
 *
 * The difference from a trend line is the whole point of having both: a trend
 * line answers "what happened between these two bars", a ray answers "where
 * does this go next", and only the second keeps meaning as new candles print.
 */
export interface RayDrawing extends DrawingBase {
  kind: 'ray'
  from: DrawingPoint
  to: DrawingPoint
}

/**
 * A level that starts where it formed and runs forward only.
 *
 * The difference from a full-width level is which claim is being made. A
 * level drawn across the whole chart says "this price matters"; a horizontal
 * ray says "this price has mattered since *here*", which is the one an order
 * block or a swing high actually supports -- the level did not exist before
 * the bar that made it.
 */
export interface HorizontalRayDrawing extends DrawingBase {
  kind: 'horizontal_ray'
  from: DrawingPoint
}

/** A moment running the full height -- a session open, a news release. */
export interface VerticalDrawing extends DrawingBase {
  kind: 'vertical'
  time: number
}

/** A trend line that says which way to read it. */
export interface ArrowDrawing extends DrawingBase {
  kind: 'arrow'
  from: DrawingPoint
  to: DrawingPoint
}

export type Drawing =
  | TrendlineDrawing
  | HorizontalDrawing
  | RectangleDrawing
  | RayDrawing
  | VerticalDrawing
  | ArrowDrawing
  | HorizontalRayDrawing

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
  select: 'Select setup',
  window: 'Test window',
  trendline: 'Trend line',
  horizontal: 'Level',
  rectangle: 'Zone',
  ray: 'Ray',
  vertical: 'Time marker',
  arrow: 'Arrow',
  horizontal_ray: 'Level from here',
}

export const TOOL_HINTS: Record<ToolMode, string> = {
  cursor: 'Pan and zoom. Click a drawing to select it, then drag it or its handles.',
  select: 'Drag across the candles that form the setup you want to test. Esc cancels.',
  window:
    'Drag across the stretch of history to test in. Candles outside it stay on the ' +
    'chart, they are simply not searched. Esc cancels.',
  trendline:
    'Drag from one point to another. Snaps to swing points while they are shown. ' +
    'Esc cancels.',
  horizontal: 'Press to preview a level, release to place it. Esc cancels.',
  rectangle: 'Drag to mark a zone. Esc cancels.',
  ray: 'Two points, then it carries on to the right edge. Esc cancels.',
  vertical: 'Press to preview a moment, release to place it. Esc cancels.',
  arrow: 'Drag from one point to another. Esc cancels.',
  horizontal_ray:
    'Press where the level forms; it runs forward from there. Esc cancels.',
}

/** Stroke widths offered. Small set: a thickness picker is not a design tool. */
export const DRAWING_WIDTHS = [1, 2, 3, 4] as const

export const DEFAULT_DRAWING_WIDTH = 2

/** True for the shapes stored as a pair of market points. */
export function hasTwoPoints(
  drawing: Drawing,
): drawing is TrendlineDrawing | RectangleDrawing | RayDrawing | ArrowDrawing {
  return (
    drawing.kind === 'trendline' ||
    drawing.kind === 'rectangle' ||
    drawing.kind === 'ray' ||
    drawing.kind === 'arrow'
  )
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

/**
 * True for every tool that owns the pointer while it is held.
 *
 * A level is included even though it places a single point: it is committed
 * on *release* rather than on press, so that the line is previewed under the
 * cursor before it exists and a mis-click can be taken back with Escape
 * while the button is still down.
 */
export function isDragTool(tool: ToolMode): boolean {
  return tool !== 'cursor'
}

/** True for the range tools, which are meaningful only on the primary chart. */
export function isRangeTool(tool: ToolMode): boolean {
  return tool === 'select' || tool === 'window'
}

/** Tools that place a single point rather than sweeping a range. */
export function isPointTool(tool: ToolMode): boolean {
  return tool === 'horizontal' || tool === 'vertical' || tool === 'horizontal_ray'
}
