import { describe, expect, it } from 'vitest'

import {
  HANDLE_RADIUS_PX,
  HIT_TOLERANCE_PX,
  distanceToSegment,
  handlePositions,
  hitKey,
  hitTestDrawing,
  hitTestDrawings,
  projectDrawing,
  resizeDrawing,
  translateDrawing,
  type DrawingHit,
  type ProjectedDrawing,
} from '@/lib/drawings'
import type {
  Drawing,
  HorizontalDrawing,
  RectangleDrawing,
  TrendlineDrawing,
} from '@/types/drawing'

const line: TrendlineDrawing = {
  id: 'line',
  kind: 'trendline',
  symbol: 'NQ',
  color: '#818cf8',
  createdAt: 0,
  from: { time: 1_000, price: 100 },
  to: { time: 2_000, price: 200 },
}

const zone: RectangleDrawing = {
  id: 'zone',
  kind: 'rectangle',
  symbol: 'NQ',
  color: '#22d3ee',
  createdAt: 0,
  from: { time: 1_000, price: 200 },
  to: { time: 2_000, price: 100 },
}

const level: HorizontalDrawing = {
  id: 'level',
  kind: 'horizontal',
  symbol: 'NQ',
  color: '#f59e0b',
  createdAt: 0,
  price: 150,
}

/** Time and price map straight to pixels, so hits are easy to reason about. */
const xOf = (ms: number) => ms / 10
const yOf = (price: number) => price

describe('distanceToSegment', () => {
  it('measures perpendicular distance to a point over the segment', () => {
    expect(distanceToSegment(5, 3, 0, 0, 10, 0)).toBe(3)
  })

  it('measures to the endpoint once past the end, not to the infinite line', () => {
    // On the infinite line through (0,0)-(10,0) this would be 0.
    expect(distanceToSegment(20, 0, 0, 0, 10, 0)).toBe(10)
  })

  it('handles a degenerate zero-length segment', () => {
    expect(distanceToSegment(3, 4, 0, 0, 0, 0)).toBe(5)
  })
})

describe('projectDrawing', () => {
  it('projects the stored points in order, without normalising them', () => {
    // `from` stays `from` even when it is below `to`: the anchors are what a
    // resize writes back to, so they must not be silently swapped.
    expect(projectDrawing(zone, xOf, yOf)).toEqual({
      id: 'zone',
      kind: 'rectangle',
      x1: 100,
      y1: 200,
      x2: 200,
      y2: 100,
    })
  })

  it('returns null when a coordinate is off-scale', () => {
    expect(projectDrawing(line, () => null, yOf)).toBeNull()
    expect(projectDrawing(level, xOf, () => null)).toBeNull()
  })
})

describe('hitTestDrawing', () => {
  const projectedLine = projectDrawing(line, xOf, yOf) as ProjectedDrawing
  const projectedZone = projectDrawing(zone, xOf, yOf) as ProjectedDrawing
  const projectedLevel = projectDrawing(level, xOf, yOf) as ProjectedDrawing

  it('finds a trend line by its body', () => {
    expect(hitTestDrawing(projectedLine, 150, 150)).toEqual({ id: 'line', part: 'body' })
  })

  it('misses a trend line just outside the tolerance', () => {
    expect(hitTestDrawing(projectedLine, 150, 150 + HIT_TOLERANCE_PX * 3)).toBeNull()
  })

  it('prefers an endpoint over the body where they overlap', () => {
    expect(hitTestDrawing(projectedLine, 100, 100)).toEqual({
      id: 'line',
      part: 'point',
      timeAnchor: 'from',
      priceAnchor: 'from',
    })
  })

  it('names both anchors on a rectangle off-diagonal corner', () => {
    // (x1, y2) is `from`'s time crossed with `to`'s price.
    expect(hitTestDrawing(projectedZone, 100, 100)).toEqual({
      id: 'zone',
      part: 'point',
      timeAnchor: 'from',
      priceAnchor: 'to',
    })
  })

  it('grabs a zone by its border', () => {
    expect(hitTestDrawing(projectedZone, 150, 200)).toEqual({ id: 'zone', part: 'body' })
  })

  it('lets the pointer through the middle of an unselected zone', () => {
    // Otherwise a large zone would stop the chart panning underneath it.
    expect(hitTestDrawing(projectedZone, 150, 150)).toBeNull()
  })

  it('opens up the interior once the zone is selected', () => {
    expect(hitTestDrawing(projectedZone, 150, 150, true)).toEqual({
      id: 'zone',
      part: 'body',
    })
  })

  it('finds a level anywhere along its width, and nowhere else', () => {
    expect(hitTestDrawing(projectedLevel, 9_999, 150)).toEqual({
      id: 'level',
      part: 'body',
    })
    expect(hitTestDrawing(projectedLevel, 50, 150 + HIT_TOLERANCE_PX * 2)).toBeNull()
  })
})

describe('hitTestDrawings', () => {
  const project = (drawings: Drawing[]) =>
    drawings
      .map((drawing) => projectDrawing(drawing, xOf, yOf))
      .filter((item): item is ProjectedDrawing => item != null)

  it('returns the topmost drawing when several overlap', () => {
    // Two levels at the same price: the later one is painted on top.
    const lower = { ...level, id: 'first' }
    const upper = { ...level, id: 'second' }
    expect(hitTestDrawings(project([lower, upper]), 50, 150)?.id).toBe('second')
  })

  it('lets the selected drawing keep its handles under an overlapping shape', () => {
    const covering = { ...level, id: 'cover', price: 100 }
    const projected = project([line, covering])
    // (100, 100) is both the line's `from` handle and on the covering level.
    expect(hitTestDrawings(projected, 100, 100, 'line')).toEqual({
      id: 'line',
      part: 'point',
      timeAnchor: 'from',
      priceAnchor: 'from',
    })
    // Without the selection, the shape on top wins.
    expect(hitTestDrawings(projected, 100, 100)?.id).toBe('cover')
  })

  it('reports nothing over empty space, so the chart keeps the pointer', () => {
    expect(hitTestDrawings(project([line, zone, level]), 400, 400)).toBeNull()
  })
})

describe('handlePositions', () => {
  it('gives a rectangle four grips and a trend line two', () => {
    expect(handlePositions(projectDrawing(zone, xOf, yOf) as ProjectedDrawing)).toHaveLength(4)
    expect(handlePositions(projectDrawing(line, xOf, yOf) as ProjectedDrawing)).toHaveLength(2)
  })

  it('gives a level none -- it is dragged by its body', () => {
    expect(handlePositions(projectDrawing(level, xOf, yOf) as ProjectedDrawing)).toEqual([])
  })

  it('paints every grip somewhere the pointer can actually grab it', () => {
    const projected = projectDrawing(zone, xOf, yOf) as ProjectedDrawing
    for (const { x, y } of handlePositions(projected)) {
      expect(hitTestDrawing(projected, x, y)?.part).toBe('point')
      // And just inside the advertised radius, still grabbable.
      expect(hitTestDrawing(projected, x + HANDLE_RADIUS_PX - 1, y)?.part).toBe('point')
    }
  })
})

describe('hitKey', () => {
  it('separates the parts of one drawing so hover updates when the grip changes', () => {
    const body: DrawingHit = { id: 'a', part: 'body' }
    const from: DrawingHit = { id: 'a', part: 'point', timeAnchor: 'from', priceAnchor: 'from' }
    const to: DrawingHit = { id: 'a', part: 'point', timeAnchor: 'to', priceAnchor: 'to' }

    expect(hitKey(body)).not.toBe(hitKey(from))
    expect(hitKey(from)).not.toBe(hitKey(to))
    expect(hitKey(from)).toBe(hitKey({ ...from }))
    expect(hitKey(null)).toBe('')
  })
})

describe('translateDrawing', () => {
  it('shifts both ends of a line by the same delta', () => {
    const moved = translateDrawing(line, 500, -25) as TrendlineDrawing
    expect(moved.from).toEqual({ time: 1_500, price: 75 })
    expect(moved.to).toEqual({ time: 2_500, price: 175 })
  })

  it('moves a level in price only -- it has no time to move in', () => {
    const moved = translateDrawing(level, 9_999, 10) as HorizontalDrawing
    expect(moved.price).toBe(160)
  })

  it('leaves the original untouched', () => {
    translateDrawing(line, 500, 500)
    expect(line.from).toEqual({ time: 1_000, price: 100 })
  })
})

describe('resizeDrawing', () => {
  it('moves one endpoint of a line and leaves the other alone', () => {
    const hit: DrawingHit = {
      id: 'line',
      part: 'point',
      timeAnchor: 'to',
      priceAnchor: 'to',
    }
    const resized = resizeDrawing(line, hit, { time: 5_000, price: 500 }) as TrendlineDrawing
    expect(resized.from).toEqual({ time: 1_000, price: 100 })
    expect(resized.to).toEqual({ time: 5_000, price: 500 })
  })

  it('splits an off-diagonal corner across both stored points', () => {
    const hit: DrawingHit = {
      id: 'zone',
      part: 'point',
      timeAnchor: 'from',
      priceAnchor: 'to',
    }
    const resized = resizeDrawing(zone, hit, { time: 400, price: 50 }) as RectangleDrawing
    // The grabbed corner takes both new values...
    expect(resized.from.time).toBe(400)
    expect(resized.to.price).toBe(50)
    // ...and the opposite corner is untouched.
    expect(resized.from.price).toBe(200)
    expect(resized.to.time).toBe(2_000)
  })

  it('is a no-op on a level and on a body hit', () => {
    const point: DrawingHit = {
      id: 'level',
      part: 'point',
      timeAnchor: 'from',
      priceAnchor: 'from',
    }
    expect(resizeDrawing(level, point, { time: 1, price: 1 })).toBe(level)
    expect(resizeDrawing(line, { id: 'line', part: 'body' }, { time: 1, price: 1 })).toBe(line)
  })
})
