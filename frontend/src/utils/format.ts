/** Formatting helpers for a dense financial UI. */

import type { Interval } from '@/types/market'

const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

const DATE_ONLY = new Intl.DateTimeFormat('en-GB', {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
})

const TIME_ONLY = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '--'
  return DATE_TIME.format(new Date(ms))
}

export function formatDate(ms: number): string {
  if (!Number.isFinite(ms)) return '--'
  return DATE_ONLY.format(new Date(ms))
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms)) return '--'
  return TIME_ONLY.format(new Date(ms))
}

/** Pick date-only vs date+time based on how coarse the interval is. */
export function formatForInterval(ms: number, interval: Interval): string {
  return interval === '1d' ? formatDate(ms) : formatDateTime(ms)
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
