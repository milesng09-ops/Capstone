import { describe, expect, it } from 'vitest'

import {
  CHIP_HEIGHT_PX,
  HANDLE_RADIUS_PX,
  HIT_TOLERANCE_PX,
  distanceToSegment,
  hitTestChips,
  rangeChip,
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
import { fibLevels, positionFromDrag } from '@/types/drawing'
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
  width: 2,
  createdAt: 0,
  from: { time: 1_000, price: 100 },
  to: { time: 2_000, price: 200 },
}

const zone: RectangleDrawing = {
  id: 'zone',
  kind: 'rectangle',
  symbol: 'NQ',
  color: '#22d3ee',
  width: 2,
  createdAt: 0,
  from: { time: 1_000, price: 200 },
  to: { time: 2_000, price: 100 },
}

const level: HorizontalDrawing = {
  id: 'level',
  kind: 'horizontal',
  symbol: 'NQ',
  color: '#f59e0b',
  width: 2,
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

describe('the dismiss tab on a backtest range', () => {
  /*
   * From the review call: "I don't know what this is. I don't think anybody
   * uses this, but... I just clicked on it and... can't be deleted, or even
   * selected." The setup band and the test window are painted on the drawing
   * canvas and held in the drawing rail, but they are not drawings -- so
   * nothing selected them and Delete had nothing to act on.
   */
  const setup = rangeChip('selection', 'setup', 6, 6)
  const window = rangeChip('window', 'test window', 6, 25)

  it('sizes the tab from its label', () => {
    expect(window.width).toBeGreaterThan(setup.width)
    expect(setup.height).toBe(CHIP_HEIGHT_PX)
  })

  it('is hit inside its box', () => {
    expect(hitTestChips([setup], 20, 12)?.kind).toBe('selection')
  })

  it('is not hit outside it', () => {
    expect(hitTestChips([setup], 20, 30)).toBeNull()
    expect(hitTestChips([setup], setup.x + setup.width + 2, 12)).toBeNull()
  })

  it('keeps the two tabs apart even though both bands start at the left', () => {
    // Stacked rather than placed at each band's own edge: two tabs sharing a
    // corner are two targets you cannot tell apart.
    expect(hitTestChips([setup, window], 20, 12)?.kind).toBe('selection')
    expect(hitTestChips([setup, window], 20, 30)?.kind).toBe('window')
  })

  it('finds nothing when no range is on the chart', () => {
    expect(hitTestChips([], 20, 12)).toBeNull()
  })
})

describe('the retracement levels', () => {
  it('puts ratio 0 at the end of the move and 1 at its start', () => {
    // The convention every platform follows, and the only one that reads
    // correctly: a retracement is measured back from where the move finished.
    const levels = fibLevels({ time: 0, price: 100 }, { time: 10, price: 200 })

    expect(levels[0]).toEqual({ ratio: 0, price: 200 })
    expect(levels.at(-1)).toEqual({ ratio: 1, price: 100 })
  })

  it('places the golden ratio at 61.8% back towards the start', () => {
    const levels = fibLevels({ time: 0, price: 0 }, { time: 10, price: 100 })
    const golden = levels.find((level) => level.ratio === 0.618)

    expect(golden?.price).toBeCloseTo(38.2, 6)
  })

  it('reads the same way on a move that ran downwards', () => {
    const levels = fibLevels({ time: 0, price: 200 }, { time: 10, price: 100 })
    const half = levels.find((level) => level.ratio === 0.5)

    expect(half?.price).toBe(150)
  })
})

describe('a position drawn by dragging', () => {
  it('puts a long stop below the entry and the target twice as far above', () => {
    expect(positionFromDrag('long', 100, 90)).toEqual({ stop: 90, target: 120 })
  })

  it('puts a short stop above the entry and the target below', () => {
    expect(positionFromDrag('short', 100, 110)).toEqual({ stop: 110, target: 80 })
  })

  it('corrects a drag that ran the wrong way for the direction', () => {
    // A stop on the wrong side of the entry is not a stop. The drag is read
    // as a distance, so a long dragged upwards still comes out as a long.
    expect(positionFromDrag('long', 100, 110)).toEqual({ stop: 90, target: 120 })
  })

  it('honours a reward multiple other than the default', () => {
    expect(positionFromDrag('long', 100, 90, 3)).toEqual({ stop: 90, target: 130 })
  })
})

describe('hit-testing the new shapes', () => {
  const brush: ProjectedDrawing = {
    id: 'brush',
    kind: 'brush',
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ],
  }

  const trade: ProjectedDrawing = {
    id: 'trade',
    kind: 'long',
    x1: 100,
    x2: 300,
    yEntry: 200,
    yStop: 260,
    yTarget: 80,
  }

  it('finds a brush anywhere along its path, not just at its ends', () => {
    expect(hitTestDrawing(brush, 50, 0)?.part).toBe('body')
    expect(hitTestDrawing(brush, 100, 50)?.part).toBe('body')
  })

  it('misses a brush away from every segment', () => {
    // Inside the corner the path turns, which no segment passes through.
    expect(hitTestDrawing(brush, 40, 60)).toBeNull()
  })

  it('names which level of a trade was grabbed', () => {
    expect(hitTestDrawing(trade, 100, 200)).toEqual({
      id: 'trade',
      part: 'level',
      level: 'entry',
    })
    expect(hitTestDrawing(trade, 100, 260)).toEqual({
      id: 'trade',
      part: 'level',
      level: 'stop',
    })
    expect(hitTestDrawing(trade, 300, 200)).toEqual({
      id: 'trade',
      part: 'level',
      level: 'end',
    })
  })

  it('grabs a trade by a level line away from the handles', () => {
    expect(hitTestDrawing(trade, 220, 260)).toEqual({ id: 'trade', part: 'body' })
  })

  it('lets the pointer through the body of an unselected trade', () => {
    // A trade box covers a lot of pane; swallowing the pointer inside it
    // would stop the chart panning across it for no visible reason.
    expect(hitTestDrawing(trade, 220, 150)).toBeNull()
    expect(hitTestDrawing(trade, 220, 150, true)).toEqual({ id: 'trade', part: 'body' })
  })

  it('gives a trade four grips and a brush none', () => {
    expect(handlePositions(trade)).toHaveLength(4)
    expect(handlePositions(brush)).toEqual([])
  })

  it('keeps hover identity apart for the levels of one trade', () => {
    const entry = hitTestDrawing(trade, 100, 200)
    const stop = hitTestDrawing(trade, 100, 260)

    expect(hitKey(entry)).not.toBe(hitKey(stop))
  })
})

describe('moving the new shapes', () => {
  const trade: Drawing = {
    id: 'trade',
    kind: 'long',
    symbol: 'NQ',
    color: '#818cf8',
    width: 2,
    createdAt: 0,
    entry: { time: 1_000, price: 100 },
    endTime: 2_000,
    stop: 90,
    target: 120,
  }

  const stroke: Drawing = {
    id: 'stroke',
    kind: 'brush',
    symbol: 'NQ',
    color: '#818cf8',
    width: 2,
    createdAt: 0,
    points: [
      { time: 1_000, price: 100 },
      { time: 1_500, price: 110 },
    ],
  }

  it('carries all three levels of a trade together', () => {
    // A stop that stayed behind would change the trade as well as move it.
    const moved = translateDrawing(trade, 500, 10)

    expect(moved).toMatchObject({
      entry: { time: 1_500, price: 110 },
      endTime: 2_500,
      stop: 100,
      target: 130,
    })
  })

  it('carries every point of a stroke', () => {
    const moved = translateDrawing(stroke, 100, 5)

    expect(moved).toMatchObject({
      points: [
        { time: 1_100, price: 105 },
        { time: 1_600, price: 115 },
      ],
    })
  })

  it('moves one level of a trade without touching the others', () => {
    const resized = resizeDrawing(
      trade,
      { id: 'trade', part: 'level', level: 'stop' },
      { time: 9_999, price: 80 },
    )

    expect(resized).toMatchObject({ stop: 80, target: 120, endTime: 2_000 })
    // The stop has no time of its own, so the grab's timestamp is ignored.
    expect(resized).toMatchObject({ entry: { time: 1_000, price: 100 } })
  })

  it('changes only the duration when the right edge is dragged', () => {
    const resized = resizeDrawing(
      trade,
      { id: 'trade', part: 'level', level: 'end' },
      { time: 5_000, price: 999 },
    )

    expect(resized).toMatchObject({ endTime: 5_000, stop: 90, target: 120 })
  })
})
