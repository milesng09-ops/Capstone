/**
 * Drawing geometry: what the pointer is over, and what a drag does to it.
 *
 * Kept out of the canvas component so it can be reasoned about -- and tested
 * -- without a chart. Hit-testing works in **pixels**, because "is the cursor
 * on this line?" is a question about the screen, not about the market. The
 * caller projects market coordinates down to pixels first. The transforms at
 * the bottom go the other way and are expressed in market units, because that
 * is how a drawing is stored and what has to survive a zoom.
 *
 * **Why a zone is grabbed by its border.** A rectangle can easily cover half
 * the pane. If its interior swallowed the pointer, the chart would stop
 * panning across a large part of itself for no visible reason. So an
 * unselected zone is grabbable only near its edges; once it *is* selected --
 * deliberately picked, from the chart or the side list -- the whole body
 * responds, which is when you actually want to drag it somewhere.
 */

import { logicalFromTime, timeFromLogical } from '@/lib/chart'
import {
  fibLevels,
  hasTwoPoints,
  isPosition,
  TEXT_CHAR_PX,
  TEXT_LINE_PX,
  type Drawing,
  type DrawingPoint,
} from '@/types/drawing'
import type { Candle } from '@/types/market'

/** Pixel slack around a line before the pointer counts as being on it. */
export const HIT_TOLERANCE_PX = 6

/** Pixel radius of an endpoint or corner grab handle. */
export const HANDLE_RADIUS_PX = 8

/** Which of the two stored points a coordinate comes from. */
export type PointKey = 'from' | 'to'

/**
 * What the pointer found.
 *
 * A `point` hit names the two anchors it edits separately, which is what
 * makes one code path serve both shapes: a trend line endpoint moves in time
 * *and* price together (`from`/`from`), while a rectangle's off-diagonal
 * corner takes its time from one stored point and its price from the other.
 */
/**
 * The draggable parts of a position.
 *
 * Named rather than anchored to a stored point pair, because a position has
 * three prices and one of them is not on the same axis as the others: entry,
 * stop and target move in price alone, and `end` moves in time alone.
 */
export type PositionHandle = 'entry' | 'stop' | 'target' | 'end'

export type DrawingHit =
  | { id: string; part: 'body' }
  | { id: string; part: 'point'; timeAnchor: PointKey; priceAnchor: PointKey }
  | { id: string; part: 'level'; level: PositionHandle }

/** A shape stored as two market points, in pixels. */
export interface ProjectedSegment {
  id: string
  kind: 'trendline' | 'rectangle' | 'ray' | 'arrow' | 'fib'
  /** `from.time`, `from.price`, `to.time`, `to.price`, in pixels. */
  x1: number
  y1: number
  x2: number
  y2: number
  /**
   * Where a ray's extension ends, beyond the pane, when the pane's size was
   * known at projection. The painter draws to it and the hit test tests
   * against it, so the part of a ray on screen is the part that can be
   * grabbed -- including after a pan has taken both anchors out of view.
   */
  farX?: number
  farY?: number
}

/** Size of the pane a projection is for, so a ray knows how far to run. */
export interface PaneExtent {
  width: number
  height: number
}

/** A planned trade, in pixels: one time span and three price levels. */
export interface ProjectedPlannedTrade {
  id: string
  kind: 'long' | 'short'
  /** Left and right edge of the box. */
  x1: number
  x2: number
  yEntry: number
  yStop: number
  yTarget: number
}

/** A freehand stroke, in pixels. */
export interface ProjectedBrush {
  id: string
  kind: 'brush'
  points: { x: number; y: number }[]
}

/** A drawing reduced to screen coordinates. */
export type ProjectedDrawing =
  | { id: string; kind: 'horizontal'; y: number }
  | { id: string; kind: 'vertical'; x: number }
  | { id: string; kind: 'horizontal_ray'; x: number; y: number }
  | { id: string; kind: 'text'; x: number; y: number; chars: number }
  | ProjectedBrush
  | ProjectedPlannedTrade
  | ProjectedSegment

/** Shortest distance from a point to a line *segment*, not the infinite line. */
export function distanceToSegment(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared === 0) return Math.hypot(px - x1, py - y1)

  // Clamped projection: past either end the nearest point is the endpoint,
  // which is what stops a short line behaving like an infinite one.
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / lengthSquared))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
}

/**
 * Where a ray from (x1, y1) through (x2, y2) leaves the pane.
 *
 * In the direction it was drawn, whichever that is. It used to run on only
 * when the second point was to the right of the first, so a ray drawn right
 * to left -- or one whose end had been dragged back past its start -- was
 * painted as a plain segment, indistinguishable from a trend line. Taken far
 * enough to be off the pane from anywhere on it; the paint is clipped.
 */
export function rayFarPoint(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  extent: PaneExtent,
): { x: number; y: number } {
  const length = Math.hypot(x2 - x1, y2 - y1)
  if (length === 0) return { x: x2, y: y2 }
  const reach = Math.max(
    length,
    Math.abs(x1) + Math.abs(y1) + 2 * (extent.width + extent.height),
  )
  return {
    x: x1 + ((x2 - x1) / length) * reach,
    y: y1 + ((y2 - y1) / length) * reach,
  }
}

/**
 * Project one drawing to pixels, or `null` if any coordinate is off-scale.
 *
 * `extent` is the pane's size, which only a ray needs: it is what tells the
 * ray how far to run past its second point.
 */
export function projectDrawing(
  drawing: Drawing,
  xOf: (ms: number) => number | null,
  yOf: (price: number) => number | null,
  extent?: PaneExtent,
): ProjectedDrawing | null {
  if (drawing.kind === 'horizontal') {
    const y = yOf(drawing.price)
    return y == null ? null : { id: drawing.id, kind: 'horizontal', y }
  }

  if (drawing.kind === 'vertical') {
    const x = xOf(drawing.time)
    return x == null ? null : { id: drawing.id, kind: 'vertical', x }
  }

  if (drawing.kind === 'text') {
    const x = xOf(drawing.at.time)
    const y = yOf(drawing.at.price)
    return x == null || y == null
      ? null
      : { id: drawing.id, kind: 'text', x, y, chars: Math.max(1, drawing.text.length) }
  }

  if (drawing.kind === 'horizontal_ray') {
    const x = xOf(drawing.from.time)
    const y = yOf(drawing.from.price)
    return x == null || y == null
      ? null
      : { id: drawing.id, kind: 'horizontal_ray', x, y }
  }

  if (drawing.kind === 'brush') {
    const points: { x: number; y: number }[] = []
    for (const point of drawing.points) {
      const x = xOf(point.time)
      const y = yOf(point.price)
      // One unprojectable point does not invalidate the stroke: the rest is
      // still on screen and still has to be grabbable. Only an empty result
      // means there is nothing to draw.
      if (x != null && y != null) points.push({ x, y })
    }
    return points.length === 0 ? null : { id: drawing.id, kind: 'brush', points }
  }

  if (isPosition(drawing)) {
    const x1 = xOf(drawing.entry.time)
    const x2 = xOf(drawing.endTime)
    const yEntry = yOf(drawing.entry.price)
    const yStop = yOf(drawing.stop)
    const yTarget = yOf(drawing.target)
    if (x1 == null || x2 == null || yEntry == null || yStop == null || yTarget == null) {
      return null
    }
    return { id: drawing.id, kind: drawing.kind, x1, x2, yEntry, yStop, yTarget }
  }

  const x1 = xOf(drawing.from.time)
  const y1 = yOf(drawing.from.price)
  const x2 = xOf(drawing.to.time)
  const y2 = yOf(drawing.to.price)
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null

  if (drawing.kind === 'ray' && extent) {
    const far = rayFarPoint(x1, y1, x2, y2, extent)
    return { id: drawing.id, kind: drawing.kind, x1, y1, x2, y2, farX: far.x, farY: far.y }
  }
  return { id: drawing.id, kind: drawing.kind, x1, y1, x2, y2 }
}

/**
 * Where a projected position's four grips sit.
 *
 * The three price levels are grabbed at the entry, where the labels are and
 * where they do not collide with the grip at the box's other end that changes
 * how long the trade is drawn as lasting. Each grip sits on the coordinate it
 * edits rather than on the left or right of the box: placed by sorting, a box
 * whose end had been dragged back past its entry swapped its grips over, and
 * the "end" grip then moved the opposite side of the trade.
 */
export function positionHandles(
  item: ProjectedPlannedTrade,
): { x: number; y: number; level: PositionHandle }[] {
  return [
    { x: item.x1, y: item.yEntry, level: 'entry' },
    { x: item.x1, y: item.yStop, level: 'stop' },
    { x: item.x1, y: item.yTarget, level: 'target' },
    { x: item.x2, y: item.yEntry, level: 'end' },
  ]
}

/**
 * The grip nearest the pointer, if any is within reach.
 *
 * Nearest rather than first: on a small shape two grips' reach overlaps, and
 * taking the first one listed made the other impossible to pick up -- a trade
 * box narrowed to one bar could never be widened again, because its end grip
 * sat inside the entry grip's radius and the entry was listed first. A tie
 * goes to the later grip, which for a position is its end, so even a box
 * with no width at all can still be pulled open.
 */
function nearestGrip<T extends { x: number; y: number }>(
  grips: T[],
  x: number,
  y: number,
): T | null {
  let best: T | null = null
  let bestDistance = HANDLE_RADIUS_PX
  for (const grip of grips) {
    const distance = Math.hypot(grip.x - x, grip.y - y)
    if (distance <= bestDistance) {
      best = grip
      bestDistance = distance
    }
  }
  return best
}

/** The ratios, kept in the shape the hit test wants. */
const FIB_RATIOS = fibLevels(
  { time: 0, price: 1 },
  { time: 0, price: 0 },
).map(({ ratio }) => ({ ratio }))

interface Corner {
  x: number
  y: number
  timeAnchor: PointKey
  priceAnchor: PointKey
}

/** Corner handles, paired with the stored anchors each one edits. */
function cornersOf(item: ProjectedSegment): Corner[] {
  const ends: Corner[] = [
    { x: item.x1, y: item.y1, timeAnchor: 'from', priceAnchor: 'from' },
    { x: item.x2, y: item.y2, timeAnchor: 'to', priceAnchor: 'to' },
  ]
  // A ray and an arrow are grabbed at their two stored points like a trend
  // line; only a rectangle has corners that mix the anchors.
  if (item.kind !== 'rectangle') return ends

  // A rectangle also has the two off-diagonal corners, which mix the anchors.
  return [
    ...ends,
    { x: item.x1, y: item.y2, timeAnchor: 'from', priceAnchor: 'to' },
    { x: item.x2, y: item.y1, timeAnchor: 'to', priceAnchor: 'from' },
  ]
}

/**
 * Narrow a projection to a position.
 *
 * A hand-written guard rather than a pair of `kind ===` checks: the projected
 * position carries `'long' | 'short'` as one discriminant, and the compiler
 * will not subtract such a member from the union through an inline
 * comparison -- so without this the branches after it still see a shape with
 * no `y1`.
 */
export function isProjectedPosition(item: ProjectedDrawing): item is ProjectedPlannedTrade {
  return item.kind === 'long' || item.kind === 'short'
}

/** Where to paint the grips on a selected drawing. */
export function handlePositions(item: ProjectedDrawing): { x: number; y: number }[] {
  // A level and a time marker span a whole axis, so there is no end to grab:
  // they are moved by their body or not at all.
  if (
    item.kind === 'horizontal' ||
    item.kind === 'vertical' ||
    item.kind === 'horizontal_ray' ||
    item.kind === 'text' ||
    // A freehand stroke has no anchors to adjust -- every point is one, and
    // a grip on each would bury the line under its own handles.
    item.kind === 'brush'
  ) {
    return []
  }
  if (isProjectedPosition(item)) {
    return positionHandles(item).map(({ x, y }) => ({ x, y }))
  }
  return cornersOf(item).map(({ x, y }) => ({ x, y }))
}

/**
 * Test one drawing. `includeInterior` opens up the inside of a zone; see the
 * note at the top of the file for why that is not the default.
 */
export function hitTestDrawing(
  item: ProjectedDrawing,
  x: number,
  y: number,
  includeInterior = false,
): DrawingHit | null {
  if (item.kind === 'horizontal') {
    // A level spans the full width, so only the vertical distance matters.
    return Math.abs(y - item.y) <= HIT_TOLERANCE_PX ? { id: item.id, part: 'body' } : null
  }

  if (item.kind === 'vertical') {
    // The mirror of a level: full height, so only horizontal distance counts.
    return Math.abs(x - item.x) <= HIT_TOLERANCE_PX ? { id: item.id, part: 'body' } : null
  }

  if (item.kind === 'text') {
    // The box the painter draws, computed the same way from the same two
    // constants -- a note clickable where it is not drawn would be worse than
    // one that cannot be clicked at all.
    const boxWidth = item.chars * TEXT_CHAR_PX + 8
    return x >= item.x - 4 &&
      x <= item.x + boxWidth &&
      y >= item.y - TEXT_LINE_PX &&
      y <= item.y + 4
      ? { id: item.id, part: 'body' }
      : null
  }

  if (item.kind === 'horizontal_ray') {
    // Only forward of its origin: behind that point the level is not drawn,
    // so it must not be grabbable there either.
    return x >= item.x - HIT_TOLERANCE_PX && Math.abs(y - item.y) <= HIT_TOLERANCE_PX
      ? { id: item.id, part: 'body' }
      : null
  }

  if (item.kind === 'brush') {
    // Every segment of the path, so the stroke is grabbable along its whole
    // length rather than only near its ends.
    for (let index = 1; index < item.points.length; index += 1) {
      const a = item.points[index - 1]
      const b = item.points[index]
      if (distanceToSegment(x, y, a.x, a.y, b.x, b.y) <= HIT_TOLERANCE_PX) {
        return { id: item.id, part: 'body' }
      }
    }
    // A stroke of one point is a dot, and still has to be clickable.
    const only = item.points[0]
    return item.points.length === 1 && Math.hypot(only.x - x, only.y - y) <= HIT_TOLERANCE_PX
      ? { id: item.id, part: 'body' }
      : null
  }

  if (isProjectedPosition(item)) {
    const grip = nearestGrip(positionHandles(item), x, y)
    if (grip) return { id: item.id, part: 'level', level: grip.level }

    const left = Math.min(item.x1, item.x2)
    const right = Math.max(item.x1, item.x2)
    for (const level of [item.yEntry, item.yStop, item.yTarget]) {
      if (distanceToSegment(x, y, left, level, right, level) <= HIT_TOLERANCE_PX) {
        return { id: item.id, part: 'body' }
      }
    }

    // The two filled halves respond as a body only once the position is
    // picked, for the same reason a zone does: a trade box covers a lot of
    // pane, and swallowing the pointer there would stop the chart panning
    // across it for no visible reason.
    const top = Math.min(item.yStop, item.yTarget)
    const bottom = Math.max(item.yStop, item.yTarget)
    return includeInterior && x >= left && x <= right && y >= top && y <= bottom
      ? { id: item.id, part: 'body' }
      : null
  }

  const corner = nearestGrip(cornersOf(item), x, y)
  if (corner) {
    return {
      id: item.id,
      part: 'point',
      timeAnchor: corner.timeAnchor,
      priceAnchor: corner.priceAnchor,
    }
  }

  if (item.kind === 'fib') {
    // The levels run forward from the move rather than stopping at it, the
    // way a horizontal ray does, because what a retracement is *for* is
    // watching price come back to one of them later.
    const left = Math.min(item.x1, item.x2)
    if (x < left - HIT_TOLERANCE_PX) return null
    for (const { ratio } of FIB_RATIOS) {
      const y1 = item.y2 + (item.y1 - item.y2) * ratio
      if (Math.abs(y - y1) <= HIT_TOLERANCE_PX) return { id: item.id, part: 'body' }
    }
    return null
  }

  if (item.kind !== 'rectangle') {
    // Trend line, ray and arrow are all grabbed along what is drawn. For a
    // ray that includes its extension: with only the segment between its
    // anchors grabbable, a ray panned until both anchors were off screen was
    // still painted across the pane and could not be picked up anywhere.
    const endX = item.kind === 'ray' ? (item.farX ?? item.x2) : item.x2
    const endY = item.kind === 'ray' ? (item.farY ?? item.y2) : item.y2
    return distanceToSegment(x, y, item.x1, item.y1, endX, endY) <= HIT_TOLERANCE_PX
      ? { id: item.id, part: 'body' }
      : null
  }

  const left = Math.min(item.x1, item.x2)
  const right = Math.max(item.x1, item.x2)
  const top = Math.min(item.y1, item.y2)
  const bottom = Math.max(item.y1, item.y2)

  if (includeInterior && x >= left && x <= right && y >= top && y <= bottom) {
    return { id: item.id, part: 'body' }
  }

  const edges: [number, number, number, number][] = [
    [left, top, right, top],
    [right, top, right, bottom],
    [right, bottom, left, bottom],
    [left, bottom, left, top],
  ]
  for (const [ax, ay, bx, by] of edges) {
    if (distanceToSegment(x, y, ax, ay, bx, by) <= HIT_TOLERANCE_PX) {
      return { id: item.id, part: 'body' }
    }
  }
  return null
}

/**
 * Topmost drawing under the pointer.
 *
 * Later drawings sit on top, so the search runs backwards. The one exception
 * is the selected drawing's handles, checked first: having just picked a
 * shape, you should be able to grab its corner even where another drawing
 * lies across it.
 */
export function hitTestDrawings(
  projected: ProjectedDrawing[],
  x: number,
  y: number,
  selectedId?: string | null,
): DrawingHit | null {
  if (selectedId) {
    const selected = projected.find((item) => item.id === selectedId)
    if (selected) {
      // A position's grips are `level` hits rather than `point` ones, and
      // were left out here: a level drawn later across a picked trade's
      // stop took the press meant for the stop.
      const hit = hitTestDrawing(selected, x, y, true)
      if (hit && (hit.part === 'point' || hit.part === 'level')) return hit
    }
  }

  for (let index = projected.length - 1; index >= 0; index -= 1) {
    const item = projected[index]
    const hit = hitTestDrawing(item, x, y, item.id === selectedId)
    if (hit) return hit
  }
  return null
}

/** Stable identity for a hit, so hover state only changes when it really has. */
export function hitKey(hit: DrawingHit | null): string {
  if (!hit) return ''
  if (hit.part === 'point') return `${hit.id}:${hit.timeAnchor}:${hit.priceAnchor}`
  if (hit.part === 'level') return `${hit.id}:${hit.level}`
  return `${hit.id}:body`
}

// --------------------------------------------------------------------------
// Transforms -- market coordinates, not pixels
// --------------------------------------------------------------------------

/**
 * Shift a whole drawing.
 *
 * The two single-axis shapes each ignore the delta they have no coordinate
 * for: a level has no time, a time marker has no price. Applying both to
 * either would invent a movement the shape cannot express.
 */
export function translateDrawing(
  drawing: Drawing,
  /** Milliseconds to add to every time, or how to move each one. */
  deltaTime: number | ((time: number) => number),
  deltaPrice: number,
): Drawing {
  const shift =
    typeof deltaTime === 'function' ? deltaTime : (time: number) => time + deltaTime
  if (drawing.kind === 'horizontal') {
    return { ...drawing, price: drawing.price + deltaPrice }
  }
  if (drawing.kind === 'vertical') {
    return { ...drawing, time: shift(drawing.time) }
  }
  if (drawing.kind === 'text') {
    return {
      ...drawing,
      at: {
        time: shift(drawing.at.time),
        price: drawing.at.price + deltaPrice,
      },
    }
  }
  if (drawing.kind === 'horizontal_ray') {
    return {
      ...drawing,
      from: {
        time: shift(drawing.from.time),
        price: drawing.from.price + deltaPrice,
      },
    }
  }
  if (drawing.kind === 'brush') {
    return {
      ...drawing,
      points: drawing.points.map((point) => ({
        time: shift(point.time),
        price: point.price + deltaPrice,
      })),
    }
  }
  if (isPosition(drawing)) {
    // All three prices move together: dragging a trade box to a different
    // part of the chart is asking "what if I had taken this here", and a
    // stop that stayed behind would change the trade as well as move it.
    return {
      ...drawing,
      entry: {
        time: shift(drawing.entry.time),
        price: drawing.entry.price + deltaPrice,
      },
      endTime: shift(drawing.endTime),
      stop: drawing.stop + deltaPrice,
      target: drawing.target + deltaPrice,
    }
  }
  return {
    ...drawing,
    from: {
      time: shift(drawing.from.time),
      price: drawing.from.price + deltaPrice,
    },
    to: {
      time: shift(drawing.to.time),
      price: drawing.to.price + deltaPrice,
    },
  }
}

/**
 * Move a time by the number of *bars* the pointer travelled, not the time.
 *
 * Bars are not evenly spread in time -- there is a weekend, and on intraday
 * charts a daily halt, between some neighbours -- so adding the pointer's
 * wall-clock delta to every anchor stretched a shape dragged across a gap and
 * dropped its ends inside the gap, where there are no candles at all. Counted
 * in bars, the shape keeps its width in bars, and a whole-bar drag lands its
 * anchors on bars. The count is not rounded: the body still follows the
 * pointer smoothly rather than jumping a bar at a time when zoomed in. Falls
 * back to the plain delta where the candles cannot place a time.
 */
export function shiftByBars(
  candles: Candle[],
  from: number,
  to: number,
): (time: number) => number {
  const plain = (time: number) => time + (to - from)
  const start = logicalFromTime(candles, from)
  const end = logicalFromTime(candles, to)
  if (start == null || end == null) return plain
  const bars = end - start
  return (time) => {
    const logical = logicalFromTime(candles, time)
    if (logical == null) return plain(time)
    return timeFromLogical(candles, logical + bars) ?? plain(time)
  }
}

/**
 * Move one endpoint or corner to `point`.
 *
 * The anchors on the hit decide which stored coordinates get written, which
 * is what lets a rectangle's off-diagonal corner take its new time from one
 * point and its new price from the other without a special case.
 *
 * `minDurationMs` is the shortest a position may be drawn as lasting --
 * normally one bar, which only the caller knows.
 */
export function resizeDrawing(
  drawing: Drawing,
  hit: DrawingHit,
  point: DrawingPoint,
  minDurationMs = 1,
): Drawing {
  if (isPosition(drawing) && hit.part === 'level') {
    /*
     * Each level stays on its own side of the entry.
     *
     * A long's target dragged below its entry was accepted and still read
     * "Long 2.00R", with the losing side painted as reward; its end dragged
     * back past its entry made a trade that closed before it opened. A level
     * pulled across the entry stops at it instead -- risk or reward zero,
     * which the box says plainly -- and the end stops a bar after the entry.
     */
    const long = drawing.kind === 'long'
    const entry = drawing.entry.price
    switch (hit.level) {
      case 'entry': {
        const low = Math.min(drawing.stop, drawing.target)
        const high = Math.max(drawing.stop, drawing.target)
        return {
          ...drawing,
          entry: { ...drawing.entry, price: Math.min(Math.max(point.price, low), high) },
        }
      }
      case 'stop':
        return {
          ...drawing,
          stop: long ? Math.min(point.price, entry) : Math.max(point.price, entry),
        }
      case 'target':
        return {
          ...drawing,
          target: long ? Math.max(point.price, entry) : Math.min(point.price, entry),
        }
      case 'end':
        return {
          ...drawing,
          endTime: Math.max(point.time, drawing.entry.time + Math.max(1, minDurationMs)),
        }
    }
  }

  if (!hasTwoPoints(drawing) || hit.part !== 'point') return drawing

  const from = { ...drawing.from }
  const to = { ...drawing.to }

  if (hit.timeAnchor === 'from') from.time = point.time
  else to.time = point.time

  if (hit.priceAnchor === 'from') from.price = point.price
  else to.price = point.price

  return { ...drawing, from, to }
}

// --------------------------------------------------------------------------
// Range chips
// --------------------------------------------------------------------------

/**
 * The dismiss tab on a backtest range.
 *
 * From the review call, about the two range tools: *"I don't know what this
 * is. I don't think anybody uses this, but... I just clicked on it and...
 * can't be deleted, or even selected."*
 *
 * He was right, and it was not a drawing bug. The setup band and the test
 * window are painted on the same canvas as the drawings and sit in the same
 * rail, but they are not drawings: clicking one selects nothing, and Delete
 * had nothing to act on. The only way out was Escape before releasing, or
 * knowing to drag a fresh range over the old one.
 *
 * So each range gets a tab that says what it is and takes it off the chart.
 * The geometry lives here, next to the drawing hit tests, so that what is
 * painted and what is clickable are computed once from the same numbers.
 */
export type RangeKind = 'selection' | 'window'

export interface RangeChip {
  kind: RangeKind
  label: string
  x: number
  y: number
  width: number
  height: number
}

export const CHIP_HEIGHT_PX = 15
/** Padding inside the tab, and the gap before the cross. */
const CHIP_PAD_PX = 5
/** Width of the cross glyph, reserved so the label never runs into it. */
const CHIP_CLOSE_PX = 9

/** Lay out a range's tab at the left edge of the band it labels. */
export function rangeChip(
  kind: RangeKind,
  label: string,
  left: number,
  top: number,
): RangeChip {
  return {
    kind,
    label,
    x: left,
    y: top,
    // The same monospace metric the note tool uses, for the same reason: the
    // box can be computed from the character count without measuring, and
    // both sides of the question agree because they use one number.
    width: label.length * TEXT_CHAR_PX + CHIP_PAD_PX * 2 + CHIP_CLOSE_PX,
    height: CHIP_HEIGHT_PX,
  }
}

/** The tab under the pointer, if any. Later chips sit on top. */
export function hitTestChips(chips: RangeChip[], x: number, y: number): RangeChip | null {
  for (let index = chips.length - 1; index >= 0; index -= 1) {
    const chip = chips[index]
    if (
      x >= chip.x &&
      x <= chip.x + chip.width &&
      y >= chip.y &&
      y <= chip.y + chip.height
    ) {
      return chip
    }
  }
  return null
}
