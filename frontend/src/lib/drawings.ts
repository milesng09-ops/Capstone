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

import type { Drawing, DrawingPoint } from '@/types/drawing'

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
export type DrawingHit =
  | { id: string; part: 'body' }
  | { id: string; part: 'point'; timeAnchor: PointKey; priceAnchor: PointKey }

/** A drawing reduced to screen coordinates. */
export type ProjectedDrawing =
  | { id: string; kind: 'horizontal'; y: number }
  | {
      id: string
      kind: 'trendline' | 'rectangle'
      /** `from.time`, `from.price`, `to.time`, `to.price`, in pixels. */
      x1: number
      y1: number
      x2: number
      y2: number
    }

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

/** Project one drawing to pixels, or `null` if any coordinate is off-scale. */
export function projectDrawing(
  drawing: Drawing,
  xOf: (ms: number) => number | null,
  yOf: (price: number) => number | null,
): ProjectedDrawing | null {
  if (drawing.kind === 'horizontal') {
    const y = yOf(drawing.price)
    return y == null ? null : { id: drawing.id, kind: 'horizontal', y }
  }

  const x1 = xOf(drawing.from.time)
  const y1 = yOf(drawing.from.price)
  const x2 = xOf(drawing.to.time)
  const y2 = yOf(drawing.to.price)
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null

  return { id: drawing.id, kind: drawing.kind, x1, y1, x2, y2 }
}

interface Corner {
  x: number
  y: number
  timeAnchor: PointKey
  priceAnchor: PointKey
}

/** Corner handles, paired with the stored anchors each one edits. */
function cornersOf(
  item: Extract<ProjectedDrawing, { kind: 'trendline' | 'rectangle' }>,
): Corner[] {
  const ends: Corner[] = [
    { x: item.x1, y: item.y1, timeAnchor: 'from', priceAnchor: 'from' },
    { x: item.x2, y: item.y2, timeAnchor: 'to', priceAnchor: 'to' },
  ]
  if (item.kind === 'trendline') return ends

  // A rectangle also has the two off-diagonal corners, which mix the anchors.
  return [
    ...ends,
    { x: item.x1, y: item.y2, timeAnchor: 'from', priceAnchor: 'to' },
    { x: item.x2, y: item.y1, timeAnchor: 'to', priceAnchor: 'from' },
  ]
}

/** Where to paint the grips on a selected drawing. */
export function handlePositions(item: ProjectedDrawing): { x: number; y: number }[] {
  if (item.kind === 'horizontal') return []
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

  for (const corner of cornersOf(item)) {
    if (Math.hypot(corner.x - x, corner.y - y) <= HANDLE_RADIUS_PX) {
      return {
        id: item.id,
        part: 'point',
        timeAnchor: corner.timeAnchor,
        priceAnchor: corner.priceAnchor,
      }
    }
  }

  if (item.kind === 'trendline') {
    return distanceToSegment(x, y, item.x1, item.y1, item.x2, item.y2) <= HIT_TOLERANCE_PX
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
      const hit = hitTestDrawing(selected, x, y, true)
      if (hit && hit.part === 'point') return hit
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
  return hit.part === 'point'
    ? `${hit.id}:${hit.timeAnchor}:${hit.priceAnchor}`
    : `${hit.id}:body`
}

// --------------------------------------------------------------------------
// Transforms -- market coordinates, not pixels
// --------------------------------------------------------------------------

/** Shift a whole drawing. A level ignores the time component; it has none. */
export function translateDrawing(
  drawing: Drawing,
  deltaTime: number,
  deltaPrice: number,
): Drawing {
  if (drawing.kind === 'horizontal') {
    return { ...drawing, price: drawing.price + deltaPrice }
  }
  return {
    ...drawing,
    from: {
      time: drawing.from.time + deltaTime,
      price: drawing.from.price + deltaPrice,
    },
    to: {
      time: drawing.to.time + deltaTime,
      price: drawing.to.price + deltaPrice,
    },
  }
}

/**
 * Move one endpoint or corner to `point`.
 *
 * The anchors on the hit decide which stored coordinates get written, which
 * is what lets a rectangle's off-diagonal corner take its new time from one
 * point and its new price from the other without a special case.
 */
export function resizeDrawing(
  drawing: Drawing,
  hit: DrawingHit,
  point: DrawingPoint,
): Drawing {
  if (drawing.kind === 'horizontal' || hit.part !== 'point') return drawing

  const from = { ...drawing.from }
  const to = { ...drawing.to }

  if (hit.timeAnchor === 'from') from.time = point.time
  else to.time = point.time

  if (hit.priceAnchor === 'from') from.price = point.price
  else to.price = point.price

  return { ...drawing, from, to }
}
