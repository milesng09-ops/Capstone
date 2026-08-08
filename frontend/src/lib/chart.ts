/**
 * Lightweight Charts helpers.
 *
 * We use Lightweight Charts rather than TradingView's Advanced Charts: the
 * Advanced Charts licence excludes personal, hobby and prototype use, which is
 * exactly what this project is. Lightweight Charts is Apache-2.0, so it can be
 * used freely -- at the cost of the drawing tools, which we build ourselves in
 * `components/chart/ChartOverlay.tsx`.
 *
 * The one sharp edge it introduces: **the library counts time in seconds, the
 * backend and the rest of this app count in milliseconds.** Conversion happens
 * here and nowhere else.
 */

import type {
  CandlestickData,
  ChartOptions,
  DeepPartial,
  HistogramData,
  UTCTimestamp,
} from 'lightweight-charts'

import type { Candle } from '@/types/market'

/** Milliseconds -> the seconds-based timestamp the chart library expects. */
export function toChartTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1000) as UTCTimestamp
}

/** Seconds from the chart library -> milliseconds used everywhere else. */
export function fromChartTime(seconds: number): number {
  return Math.round(seconds * 1000)
}

export function candlesToSeries(candles: Candle[]): CandlestickData<UTCTimestamp>[] {
  return candles.map((candle) => ({
    time: toChartTime(candle.time),
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
  }))
}

export function candlesToVolume(
  candles: Candle[],
  upColor: string,
  downColor: string,
): HistogramData<UTCTimestamp>[] {
  return candles.map((candle) => ({
    time: toChartTime(candle.time),
    value: candle.volume,
    color: candle.close >= candle.open ? upColor : downColor,
  }))
}

export interface ChartPalette {
  background: string
  text: string
  grid: string
  border: string
  bull: string
  bear: string
  accent: string
  muted: string
}

const FALLBACK_PALETTE: ChartPalette = {
  background: '#080b12',
  text: '#e2e8f0',
  grid: 'rgba(148, 163, 184, 0.08)',
  border: '#232a3a',
  bull: '#3fa87a',
  bear: '#e05263',
  accent: '#6366f1',
  muted: '#8b96a8',
}

/**
 * Convert a Tailwind-style HSL custom property into a hex colour.
 *
 * The variables in `index.css` hold bare components -- `222 47% 5%` -- in the
 * CSS Color Level 4 space-separated form. Lightweight Charts ships its own
 * colour parser that only understands hex, `rgb()` and *comma*-separated
 * `hsl()`, and throws outright on the modern syntax, so the conversion has to
 * happen before the value ever reaches the library.
 */
function hslVarToHex(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith('#')) return trimmed

  const parts = trimmed.replace(/%/g, '').split(/[\s,]+/)
  if (parts.length < 3) return null

  const hue = Number(parts[0])
  const saturation = Number(parts[1]) / 100
  const lightness = Number(parts[2]) / 100
  if (!Number.isFinite(hue) || !Number.isFinite(saturation) || !Number.isFinite(lightness)) {
    return null
  }

  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const secondary = chroma * (1 - Math.abs(((hue / 60) % 2) - 1))
  const match = lightness - chroma / 2

  const sector = Math.floor(((hue % 360) + 360) % 360 / 60)
  const [r, g, b] = (
    [
      [chroma, secondary, 0],
      [secondary, chroma, 0],
      [0, chroma, secondary],
      [0, secondary, chroma],
      [secondary, 0, chroma],
      [chroma, 0, secondary],
    ] as const
  )[sector] ?? [0, 0, 0]

  const channel = (value: number) =>
    Math.round(Math.min(1, Math.max(0, value + match)) * 255)
      .toString(16)
      .padStart(2, '0')

  return `#${channel(r)}${channel(g)}${channel(b)}`
}

/** `#rrggbb` plus an alpha channel, as `rgba()`. */
export function withAlpha(hex: string, alpha: number): string {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)
  if (!match) return hex
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16))
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

/**
 * Read the palette from the CSS custom properties in `index.css`.
 *
 * Doing it this way means the chart follows the stylesheet: change a colour in
 * one place and candles, grid and overlays all move with it.
 */
export function readChartPalette(): ChartPalette {
  if (typeof window === 'undefined') return FALLBACK_PALETTE

  const styles = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: string): string =>
    hslVarToHex(styles.getPropertyValue(name)) ?? fallback

  const border = read('--border', FALLBACK_PALETTE.border)

  return {
    background: read('--panel', FALLBACK_PALETTE.background),
    text: read('--foreground', FALLBACK_PALETTE.text),
    grid: withAlpha(border, 0.45),
    border,
    bull: read('--bull', FALLBACK_PALETTE.bull),
    bear: read('--bear', FALLBACK_PALETTE.bear),
    accent: read('--primary', FALLBACK_PALETTE.accent),
    muted: read('--muted-foreground', FALLBACK_PALETTE.muted),
  }
}

export function baseChartOptions(
  palette: ChartPalette,
  precision: number,
): DeepPartial<ChartOptions> {
  return {
    layout: {
      background: { color: 'transparent' },
      textColor: palette.muted,
      fontSize: 11,
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
    },
    grid: {
      vertLines: { color: palette.grid },
      horzLines: { color: palette.grid },
    },
    crosshair: {
      // Magnet mode snaps the crosshair to OHLC values, which is what makes
      // "is this the same high?" answerable by eye across two charts.
      mode: 1,
      vertLine: {
        color: palette.muted,
        width: 1,
        style: 3,
        labelBackgroundColor: palette.accent,
      },
      horzLine: {
        color: palette.muted,
        width: 1,
        style: 3,
        labelBackgroundColor: palette.accent,
      },
    },
    rightPriceScale: {
      borderColor: palette.border,
      scaleMargins: { top: 0.12, bottom: 0.24 },
      entireTextOnly: true,
    },
    timeScale: {
      borderColor: palette.border,
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 4,
      barSpacing: 8,
    },
    localization: {
      priceFormatter: (price: number) => price.toFixed(precision),
    },
    handleScroll: { mouseWheel: true, pressedMouseMove: true },
    handleScale: { mouseWheel: true, pinch: true },
    autoSize: true,
  }
}

/**
 * Find the candle whose open time is closest to `ms`.
 *
 * Drawings snap to bars so that a level placed between two candles does not
 * land on a timestamp that has no data behind it.
 */
export function nearestBarTime(candles: Candle[], ms: number): number | null {
  if (candles.length === 0) return null

  let low = 0
  let high = candles.length - 1
  if (ms <= candles[low].time) return candles[low].time
  if (ms >= candles[high].time) return candles[high].time

  while (high - low > 1) {
    const middle = (low + high) >> 1
    if (candles[middle].time === ms) return ms
    if (candles[middle].time < ms) low = middle
    else high = middle
  }

  return ms - candles[low].time <= candles[high].time - ms
    ? candles[low].time
    : candles[high].time
}

/** Index of the candle at `ms`, or -1. Used to size selections in bars. */
export function indexOfBar(candles: Candle[], ms: number): number {
  let low = 0
  let high = candles.length - 1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (candles[middle].time === ms) return middle
    if (candles[middle].time < ms) low = middle + 1
    else high = middle - 1
  }
  return -1
}
