/** Formatting helpers for a dense financial UI. */

import { isDailyOrLonger, type Interval } from '@/types/market'
import {
  DEFAULT_EXCHANGE_ZONE,
  LOCAL_TIME_ZONE,
  resolveTimeZone,
  tradingDayInstant,
  type TimeZoneId,
} from '@/utils/timezone'

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

type Shape = 'dateTime' | 'date' | 'month' | 'time' | 'clock'

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
  month: { year: 'numeric', month: 'short' },
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

/**
 * The trading day a daily, weekly or monthly bar stands for.
 *
 * Not the bar's own timestamp: those bars open at 17:00 exchange time on the
 * evening before, so formatting the stamp labelled Monday's bar as Sunday and
 * October's as 30 September. See `tradingDayInstant`. A month is named by
 * its month alone, since its first trading day is not a date anyone means by
 * "the October candle".
 *
 * Read in the exchange's zone whatever clock the rest of the app is drawn
 * in. Every instrument here is a CME future; pass the instrument's own zone
 * the day that stops being true.
 */
export function formatTradingDay(
  ms: number,
  interval: string,
  exchangeZone: string = DEFAULT_EXCHANGE_ZONE,
): string {
  if (!Number.isFinite(ms)) return '--'
  const shape: Shape = interval === '1mo' ? 'month' : 'date'
  return formatter(shape, exchangeZone).format(new Date(tradingDayInstant(ms)))
}

/**
 * A bar's time, in the form its interval is read in.
 *
 * Intraday bars are moments, and are shown as one in the chosen zone. Daily
 * and coarser bars are trading days, and are named by the day they trade --
 * which `formatDate` on the raw stamp gets wrong by one.
 */
export function formatForInterval(
  ms: number,
  interval: string,
  zone: TimeZoneId = activeZone,
): string {
  return isDailyOrLonger(interval)
    ? formatTradingDay(ms, interval)
    : formatDateTime(ms, zone)
}

/**
 * The value to print, with a result that rounds to nothing made plain zero.
 *
 * A trade that lost 0.0018% printed "-0.00%" -- a minus sign on a number
 * that shows no loss, which reads as a small loss that the table then
 * declines to state. JavaScript keeps the sign of a negative number through
 * rounding (`(-0.0018).toFixed(2)` is "-0.00") and so does `Intl`, so the
 * zero has to be caught before either sees it.
 */
function displayed(value: number, digits: number): number {
  return Number(value.toFixed(digits)) === 0 ? 0 : value
}

export function formatPrice(value: number, precision = 2): string {
  if (!Number.isFinite(value)) return '--'
  return displayed(value, precision).toLocaleString('en-US', {
    minimumFractionDigits: precision,
    maximumFractionDigits: precision,
  })
}

/**
 * A signed percentage. Zero -- including anything that rounds to it -- has no
 * sign either way: "+0.00%" claims a gain as surely as "-0.00%" claims a loss.
 */
export function formatPercent(value: number, digits = 2, withSign = true): string {
  if (!Number.isFinite(value)) return '--'
  const shown = displayed(value, digits)
  const sign = withSign && shown > 0 ? '+' : ''
  return `${sign}${shown.toFixed(digits)}%`
}

export function formatNumber(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return '--'
  return displayed(value, digits).toLocaleString('en-US', {
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
  return displayed(value, digits).toLocaleString('en-US', {
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
  // `Math.round(-0.4)` is -0, which `Intl` prints as "-0".
  const rounded = Math.round(value)
  return (rounded === 0 ? 0 : rounded).toLocaleString('en-US')
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
