/** Formatting helpers for a dense financial UI. */

import type { Interval } from '@/types/market'
import { LOCAL_TIME_ZONE, resolveTimeZone, type TimeZoneId } from '@/utils/timezone'

/**
 * Every timestamp in the app is drawn in the zone picked in the status bar.
 *
 * Holding it in a module variable rather than threading it through each call
 * leaves the fifteen-odd places that print a time unchanged; the store sets it,
 * and the components that show timestamps subscribe to `timeZone` so they
 * re-render when it moves.
 */
let activeZone: TimeZoneId = LOCAL_TIME_ZONE

export function setFormattingTimeZone(zone: TimeZoneId): void {
  activeZone = zone
}

type Shape = 'dateTime' | 'date' | 'time' | 'clock'

const SHAPES: Record<Shape, Intl.DateTimeFormatOptions> = {
  dateTime: {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  },
  date: { year: 'numeric', month: 'short', day: '2-digit' },
  time: { hour: '2-digit', minute: '2-digit', hour12: false },
  clock: { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
}

// Building an Intl formatter is expensive enough to matter in a table of a few
// hundred trades, so one is kept per shape and zone.
const FORMATTERS = new Map<string, Intl.DateTimeFormat>()

function formatter(shape: Shape, zone: TimeZoneId): Intl.DateTimeFormat {
  const key = `${shape}|${zone}`
  let cached = FORMATTERS.get(key)
  if (!cached) {
    cached = new Intl.DateTimeFormat('en-GB', {
      timeZone: resolveTimeZone(zone),
      ...SHAPES[shape],
    })
    FORMATTERS.set(key, cached)
  }
  return cached
}

export function formatDateTime(ms: number, zone: TimeZoneId = activeZone): string {
  if (!Number.isFinite(ms)) return '--'
  return formatter('dateTime', zone).format(new Date(ms))
}

export function formatDate(ms: number, zone: TimeZoneId = activeZone): string {
  if (!Number.isFinite(ms)) return '--'
  return formatter('date', zone).format(new Date(ms))
}

export function formatTime(ms: number, zone: TimeZoneId = activeZone): string {
  if (!Number.isFinite(ms)) return '--'
  return formatter('time', zone).format(new Date(ms))
}

/** `HH:MM:SS` -- the running clock in the status bar. */
export function formatClock(ms: number, zone: TimeZoneId = activeZone): string {
  if (!Number.isFinite(ms)) return '--:--:--'
  return formatter('clock', zone).format(new Date(ms))
}

/** Pick date-only vs date+time based on how coarse the interval is. */
export function formatForInterval(
  ms: number,
  interval: Interval,
  zone: TimeZoneId = activeZone,
): string {
  return interval === '1d' ? formatDate(ms, zone) : formatDateTime(ms, zone)
}

export function formatPrice(value: number, precision = 2): string {
  if (!Number.isFinite(value)) return '--'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })
}

export function formatPercent(value: number, digits = 2, withSign = true): string {
  if (!Number.isFinite(value)) return '--'
  const sign = withSign && value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--'
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/**
 * Money, to the cent.
 *
 * Fixed to USD because every instrument in the catalogue settles in it. The
 * day that stops being true, the currency belongs in the instrument metadata
 * rather than hard-coded here.
 */
export function formatCurrency(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--'
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '--'
  return Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  )
}

export function formatInteger(value: number): string {
  if (!Number.isFinite(value)) return '--'
  return Math.round(value).toLocaleString('en-US')
}

/** `1.234` -> `1.23x`, with a cap so an infinite profit factor stays readable. */
export function formatRatio(value: number | null): string {
  // An undefined ratio (no losing trades) reads as a dash, never as a large
  // number that could be mistaken for a measured result.
  if (value == null || !Number.isFinite(value)) return '--'
  return `${value.toFixed(2)}x`
}

export function formatDuration(bars: number, interval: Interval): string {
  const label = bars === 1 ? 'bar' : 'bars'
  return `${bars} ${label} (${interval})`
}

export function formatRelativeTime(ms: number | null | undefined): string {
  if (!ms) return 'never'
  const delta = Date.now() - ms
  if (delta < 60_000) return 'just now'
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`
  return `${Math.floor(delta / 86_400_000)}d ago`
}

/** Tailwind text colour for a signed value. */
export function directionClass(value: number): string {
  if (value > 0) return 'text-bull'
  if (value < 0) return 'text-bear'
  return 'text-muted-foreground'
}
