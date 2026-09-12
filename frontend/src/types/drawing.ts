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
  | 'text'
  | 'fib'
  | 'long'
  | 'short'
  | 'brush'

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

/**
 * A note pinned to a point on the chart.
 *
 * Anchored in market coordinates like everything else, so "this is the bias"
 * stays on the bar it was written about rather than drifting to wherever the
 * screen has moved to.
 */
export interface TextDrawing extends DrawingBase {
  kind: 'text'
  at: DrawingPoint
  text: string
}

/**
 * A Fibonacci retracement between two swings.
 *
 * Stored as the two points the trader picked -- the swing the move ran from
 * and the swing it ran to -- with the levels derived at paint time rather
 * than stored. That is what keeps the tool honest when a point is dragged:
 * the ratios are a property of the tool, the prices are a property of the
 * move, and only one of the two is the user's to change.
 */
export interface FibDrawing extends DrawingBase {
  kind: 'fib'
  from: DrawingPoint
  to: DrawingPoint
}

/**
 * The retracement levels drawn, as fractions of the move.
 *
 * 0 and 1 are the swings themselves, and are drawn because the tool is read
 * as a whole: a retracement with no visible extremes is a set of floating
 * lines. 0.5 is not a Fibonacci ratio at all -- it is there because traders
 * use it, which is the only reason any of these are on a chart.
 */
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1] as const

/**
 * A planned trade, drawn on the chart -- entry, stop and target.
 *
 * Miles asked for this for manual backtesting: scroll back, mark where you
 * would have entered and where the stop and target would have sat, and read
 * off whether the trade worked. It is deliberately *not* wired to the
 * backtest engine. The engine answers "what did this rule do across two
 * hundred instances"; this answers "what would I have done here", and
 * conflating them would let a hand-placed box be counted as a result.
 *
 * `direction` rather than two shapes: long and short differ only in which
 * side of the entry the stop sits on, and one shape with a flag cannot drift
 * out of step with itself the way two near-copies can.
 */
export interface PositionDrawing extends DrawingBase {
  kind: 'long' | 'short'
  /** Entry: the time the trade opens, and the price it opens at. */
  entry: DrawingPoint
  /** Right edge of the box. The trade is drawn as lasting this long. */
  endTime: number
  stop: number
  target: number
}

/** Reward offered per unit of risk when a position is first drawn. */
export const DEFAULT_POSITION_R = 2

/**
 * A freehand line.
 *
 * The points are the pointer path in market coordinates, thinned as it is
 * collected -- a raw pointer stream is hundreds of points a second, and
 * storing them all would put a drawing in `localStorage` that is larger than
 * the rest of the workspace put together.
 */
export interface BrushDrawing extends DrawingBase {
  kind: 'brush'
  points: DrawingPoint[]
}

/** Pixels the pointer must travel before the brush records another point. */
export const BRUSH_MIN_STEP_PX = 3

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
  | TextDrawing
  | FibDrawing
  | PositionDrawing
  | BrushDrawing

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
  text: 'Note',
  fib: 'Fibonacci retracement',
  long: 'Long position',
  short: 'Short position',
  brush: 'Freehand',
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
  text: 'Press to drop a note, then type into it. Esc cancels.',
  fib:
    'Drag from one swing to the other; the retracement levels are drawn ' +
    'between them. Esc cancels.',
  long:
    'Drag from the entry to where the stop would sit. The target is placed ' +
    'at twice the risk, and every level can be dragged. Esc cancels.',
  short:
    'Drag from the entry to where the stop would sit. The target is placed ' +
    'at twice the risk, and every level can be dragged. Esc cancels.',
  brush: 'Draw freehand. Esc cancels.',
}

/**
 * Note metrics, shared by the painter and the hit test.
 *
 * A note is drawn in a monospace face, so its box can be computed from the
 * character count without measuring. Both sides using the same two numbers is
 * what stops a note being clickable somewhere it is not drawn.
 */
export const TEXT_CHAR_PX = 6.1
export const TEXT_LINE_PX = 15
export const DEFAULT_NOTE = 'Note'

/** Stroke widths offered. Small set: a thickness picker is not a design tool. */
export const DRAWING_WIDTHS = [1, 2, 3, 4] as const

export const DEFAULT_DRAWING_WIDTH = 2

/** True for the shapes stored as a pair of market points. */
export function hasTwoPoints(
  drawing: Drawing,
): drawing is
  | TrendlineDrawing
  | RectangleDrawing
  | RayDrawing
  | ArrowDrawing
  | FibDrawing {
  return (
    drawing.kind === 'trendline' ||
    drawing.kind === 'rectangle' ||
    drawing.kind === 'ray' ||
    drawing.kind === 'arrow' ||
    drawing.kind === 'fib'
  )
}

/** True for the two position tools, which share one shape. */
export function isPosition(drawing: Drawing): drawing is PositionDrawing {
  return drawing.kind === 'long' || drawing.kind === 'short'
}

/**
 * Price levels for a retracement, from the end of the move back to its start.
 *
 * Ratio 0 sits at the *end* of the move and 1 at its start, which is the
 * convention every platform follows and the only one that reads correctly: a
 * retracement is measured back from where the move finished.
 */
export function fibLevels(
  from: DrawingPoint,
  to: DrawingPoint,
): { ratio: number; price: number }[] {
  return FIB_LEVELS.map((ratio) => ({
    ratio,
    price: to.price + (from.price - to.price) * ratio,
  }))
}

/**
 * Where the stop and target sit for a freshly drawn position.
 *
 * The drag sets the risk -- entry to stop -- because that is the number a
 * trader actually decides. The target follows from it, because a reward is
 * only meaningful as a multiple of what was risked.
 */
export function positionFromDrag(
  direction: 'long' | 'short',
  entry: number,
  stop: number,
  reward = DEFAULT_POSITION_R,
): { stop: number; target: number } {
  // A stop on the wrong side of the entry is not a stop. The drag is read as
  // a distance and placed on the side the direction demands, so a long drawn
  // upwards still comes out as a long.
  const risk = Math.abs(entry - stop)
  return direction === 'long'
    ? { stop: entry - risk, target: entry + risk * reward }
    : { stop: entry + risk, target: entry - risk * reward }
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
  return (
    tool === 'horizontal' ||
    tool === 'vertical' ||
    tool === 'horizontal_ray' ||
    tool === 'text'
  )
}

/**
 * Tools that follow the pointer's whole path rather than its two ends.
 *
 * The brush is the only one, and it is excluded from the two-click placement
 * every other shape uses: a freehand line has no "first point", so arming one
 * would leave the tool waiting for a second click that means nothing.
 */
export function isPathTool(tool: ToolMode): boolean {
  return tool === 'brush'
}

/**
 * The moment a drawing is anchored at, for listing and ordering.
 *
 * Every shape has one except the full-width level, which is a claim about a
 * price at every time; that answers with when it was created, since a list
 * sorted by "no time" is not sorted at all.
 */
export function drawingTime(drawing: Drawing): number {
  switch (drawing.kind) {
    case 'horizontal':
      return drawing.createdAt
    case 'vertical':
      return drawing.time
    case 'text':
      return drawing.at.time
    case 'horizontal_ray':
      return drawing.from.time
    case 'brush':
      return drawing.points[0]?.time ?? drawing.createdAt
    case 'long':
    case 'short':
      return drawing.entry.time
    default:
      return drawing.from.time
  }
}
