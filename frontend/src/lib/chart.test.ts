import { beforeEach, describe, expect, it } from 'vitest'

import {
  indexOfBar,
  logicalFromTime,
  medianBarSpacingMs,
  nearestBarTime,
  readChartPalette,
  snapWithinBars,
  timeFromLogical,
  withAlpha,
} from '@/lib/chart'
import type { Candle } from '@/types/market'

function candle(time: number): Candle {
  return { symbol: 'NQ', time, open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }
}

describe('readChartPalette', () => {
  beforeEach(() => {
    const root = document.documentElement.style
    root.setProperty('--bull', '120 100% 50%')
    root.setProperty('--bear', '0 100% 50%')
    root.setProperty('--primary', '240 100% 50%')
    root.setProperty('--border', '0 0% 100%')
    root.setProperty('--panel', '0 0% 0%')
    root.setProperty('--muted-foreground', '215 16% 60%')
    root.setProperty('--foreground', '0 0% 100%')
  })

  it('converts space-separated HSL custom properties to hex', () => {
    const palette = readChartPalette()
    expect(palette.bull).toBe('#00ff00')
    expect(palette.bear).toBe('#ff0000')
    expect(palette.accent).toBe('#0000ff')
    expect(palette.background).toBe('#000000')
  })

  it('never emits the CSS Color 4 syntax that the chart library cannot parse', () => {
    // Lightweight Charts throws outright on `hsl(215 16% 60%)`. Emitting one
    // blanks every chart, so this is the regression that matters.
    const palette = readChartPalette()
    for (const value of Object.values(palette)) {
      expect(value).not.toMatch(/hsl\(\s*[\d.]+\s+/)
    }
    expect(palette.muted).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('renders the grid as a translucent rgba colour', () => {
    expect(readChartPalette().grid).toBe('rgba(255, 255, 255, 0.45)')
  })
})

describe('withAlpha', () => {
  it('adds an alpha channel to a hex colour', () => {
    expect(withAlpha('#40b57e', 0.35)).toBe('rgba(64, 181, 126, 0.35)')
  })

  it('passes non-hex input through untouched', () => {
    expect(withAlpha('transparent', 0.5)).toBe('transparent')
  })
})

describe('nearestBarTime', () => {
  const candles = [1000, 2000, 3000, 4000].map(candle)

  it('returns an exact bar unchanged', () => {
    expect(nearestBarTime(candles, 3000)).toBe(3000)
  })

  it('snaps to the closest bar on either side', () => {
    expect(nearestBarTime(candles, 2400)).toBe(2000)
    expect(nearestBarTime(candles, 2600)).toBe(3000)
  })

  it('clamps outside the series', () => {
    expect(nearestBarTime(candles, 0)).toBe(1000)
    expect(nearestBarTime(candles, 99_999)).toBe(4000)
  })

  it('returns null with no candles', () => {
    expect(nearestBarTime([], 1000)).toBeNull()
  })
})

describe('snapWithinBars', () => {
  const candles = [1000, 2000, 3000, 4000].map(candle)

  it('snaps to the closest bar inside the range', () => {
    expect(snapWithinBars(candles, 2400)).toBe(2000)
    expect(snapWithinBars(candles, 2600)).toBe(3000)
  })

  it('refuses to clamp outside the range', () => {
    // This is the whole point: nearestBarTime would collapse both of these
    // onto an edge candle, which is what stopped drawings living in the
    // empty space beyond the data.
    expect(snapWithinBars(candles, 0)).toBeNull()
    expect(snapWithinBars(candles, 99_999)).toBeNull()
  })

  it('returns null with no candles', () => {
    expect(snapWithinBars([], 1000)).toBeNull()
  })
})

describe('medianBarSpacingMs', () => {
  it('ignores session gaps rather than averaging them in', () => {
    // A weekend-sized hole between two bars must not stretch the estimate.
    const candles = [0, 1000, 2000, 500_000, 501_000, 502_000].map(candle)
    expect(medianBarSpacingMs(candles)).toBe(1000)
  })

  it('returns null when there is nothing to measure', () => {
    expect(medianBarSpacingMs([])).toBeNull()
    expect(medianBarSpacingMs([candle(1000)])).toBeNull()
  })
})

describe('logicalFromTime / timeFromLogical', () => {
  const candles = [1000, 2000, 3000, 4000].map(candle)

  it('maps bars onto their index', () => {
    expect(logicalFromTime(candles, 1000)).toBe(0)
    expect(logicalFromTime(candles, 4000)).toBe(3)
  })

  it('interpolates between two bars', () => {
    expect(logicalFromTime(candles, 2500)).toBeCloseTo(1.5)
  })

  it('extrapolates past the last bar so drawings can go there', () => {
    expect(logicalFromTime(candles, 6000)).toBeCloseTo(5)
  })

  it('extrapolates before the first bar', () => {
    expect(logicalFromTime(candles, -1000)).toBeCloseTo(-2)
  })

  it('round-trips through logical coordinates on both sides of the data', () => {
    for (const ms of [-5000, 1000, 2500, 4000, 12_345]) {
      const logical = logicalFromTime(candles, ms)
      expect(logical).not.toBeNull()
      expect(timeFromLogical(candles, logical as number)).toBe(ms)
    }
  })

  it('returns null with no candles', () => {
    expect(logicalFromTime([], 1000)).toBeNull()
    expect(timeFromLogical([], 0)).toBeNull()
  })
})

describe('indexOfBar', () => {
  const candles = [1000, 2000, 3000].map(candle)

  it('finds an exact bar', () => {
    expect(indexOfBar(candles, 2000)).toBe(1)
  })

  it('reports -1 when the time is not a bar', () => {
    expect(indexOfBar(candles, 2500)).toBe(-1)
  })
})
