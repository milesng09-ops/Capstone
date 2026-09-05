/**
 * Time zones for the clock in the status bar and every timestamp the app
 * prints.
 *
 * A chart with no time zone on it is a chart you cannot check: "the London
 * open" is a different bar depending on whose clock you read it against, and
 * the offset moves twice a year. So the zone is chosen once, shown next to a
 * running clock, and every formatter in the app reads it.
 *
 * The list is deliberately short -- the exchange zones this tool actually
 * charts, plus UTC and whatever the machine is set to. A full IANA list would
 * be several hundred entries of scrolling to reach the four that matter.
 */

/** IANA zone name, or `local` for "whatever this machine is set to". */
export type TimeZoneId = string

export const LOCAL_TIME_ZONE = 'local'

export const TIME_ZONES: readonly { value: TimeZoneId; label: string }[] = [
  { value: LOCAL_TIME_ZONE, label: 'Local' },
  { value: 'UTC', label: 'UTC' },
  { value: 'America/New_York', label: 'New York' },
  { value: 'America/Chicago', label: 'Chicago' },
  { value: 'Europe/London', label: 'London' },
  { value: 'Europe/Berlin', label: 'Frankfurt' },
  { value: 'Asia/Tokyo', label: 'Tokyo' },
  { value: 'Asia/Singapore', label: 'Singapore' },
  { value: 'Australia/Sydney', label: 'Sydney' },
]

/** The machine's own zone, used when the choice is `local`. */
export function machineTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** The IANA name to hand to `Intl`, resolving `local`. */
export function resolveTimeZone(zone: TimeZoneId): string {
  return zone === LOCAL_TIME_ZONE ? machineTimeZone() : zone
}

export function isKnownTimeZone(zone: unknown): zone is TimeZoneId {
  return typeof zone === 'string' && TIME_ZONES.some((item) => item.value === zone)
}

export function timeZoneLabel(zone: TimeZoneId): string {
  return TIME_ZONES.find((item) => item.value === zone)?.label ?? zone
}

const PARTS_CACHE = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(ianaZone: string): Intl.DateTimeFormat {
  let formatter = PARTS_CACHE.get(ianaZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: ianaZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    PARTS_CACHE.set(ianaZone, formatter)
  }
  return formatter
}

/**
 * Minutes that `zone` is ahead of UTC at `ms`.
 *
 * Computed by formatting the instant in the zone and reading the wall-clock
 * back, rather than from a `longOffset` time zone name: the difference is what
 * an offset *is*, it needs no lookup table, and it lands on the right side of
 * a daylight-saving change because the instant carries the change with it.
 */
export function offsetMinutes(zone: TimeZoneId, ms: number = Date.now()): number {
  const iana = resolveTimeZone(zone)
  const parts = partsFormatter(iana).formatToParts(new Date(ms))
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value ?? '0')

  // `hour: '2-digit'` with hour12 false can produce 24 for midnight in some
  // engines; Date.UTC rolls that over to the next day, which is correct.
  const asUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  )

  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000)
}

/** `UTC`, `UTC-4`, `UTC+5:30` -- the form charting platforms print. */
export function offsetLabel(zone: TimeZoneId, ms: number = Date.now()): string {
  const minutes = offsetMinutes(zone, ms)
  if (minutes === 0) return 'UTC'
  const sign = minutes < 0 ? '-' : '+'
  const absolute = Math.abs(minutes)
  const hours = Math.floor(absolute / 60)
  const rest = absolute % 60
  return rest === 0
    ? `UTC${sign}${hours}`
    : `UTC${sign}${hours}:${String(rest).padStart(2, '0')}`
}
