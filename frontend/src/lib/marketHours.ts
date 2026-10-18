/**
 * When the CME equity index futures trade -- ES, NQ and YM -- on the
 * exchange's own clock.
 *
 * Sunday 17:00 to Friday 16:00 Chicago time, with an hour's maintenance halt
 * from 16:00 on the weekdays between. The live price is only worth asking for
 * inside those hours: outside them the provider has nothing new, and every
 * question still spends a call from a quota of five a minute.
 *
 * Exchange holidays are the ones CME has published, below; on a holiday
 * outside that list the chart keeps asking for a bar that does not come -- a
 * call a minute per market, and nothing wrong on screen.
 */

import { SESSION_OPEN_HOUR } from '@/utils/timezone'
import type { Candle, Interval } from '@/types/market'
import { INTERVAL_MS } from '@/types/market'

const EXCHANGE = 'America/Chicago'
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS

/** The hour the market shuts on a Friday, and halts on the other weekdays. */
const SESSION_CLOSE_HOUR = 16

/**
 * Where CME closes the equity index futures beyond the weekly schedule --
 * holiday halts, early closes and whole-day closures -- as Chicago wall-clock
 * times, from inclusive, until exclusive, with what each one is.
 *
 * Source: CME Group's Globex holiday schedule, read from the trading-hours
 * service behind https://www.cmegroup.com/trading-hours.html (products 133
 * ES, 146 NQ and 318 YM, which carry one schedule) on 18 October 2026. It
 * holds nothing before 19 October 2025, so earlier holidays are not listed.
 * Keep in step with `HOLIDAY_CLOSURES` in the backend's
 * `app/providers/trading_hours.py`, which has the longer note on what was
 * left out and why; a backend test reads the two against each other.
 */
export const CME_HOLIDAY_CLOSURES: readonly (readonly [string, string, string])[] = [
  ['2025-11-27 12:00', '2025-11-27 17:00', 'Thanksgiving'],
  ['2025-11-28 12:15', '2025-11-28 17:00', 'Day after Thanksgiving, early close'],
  ['2025-12-24 12:15', '2025-12-25 17:00', 'Christmas'],
  ['2025-12-31 17:00', '2026-01-01 17:00', "New Year's Day"],
  ['2026-01-19 12:00', '2026-01-19 17:00', 'Martin Luther King Jr. Day'],
  ['2026-02-16 12:00', '2026-02-16 17:00', "Presidents' Day"],
  ['2026-04-03 08:15', '2026-04-03 17:00', 'Good Friday, abbreviated session'],
  ['2026-05-25 12:00', '2026-05-25 17:00', 'Memorial Day'],
  ['2026-06-19 12:00', '2026-06-19 17:00', 'Juneteenth'],
  ['2026-07-03 12:00', '2026-07-03 17:00', 'Independence Day, observed'],
  ['2026-09-07 12:00', '2026-09-07 17:00', 'Labor Day'],
  ['2026-11-26 12:00', '2026-11-26 17:00', 'Thanksgiving'],
  ['2026-11-27 12:15', '2026-11-27 17:00', 'Day after Thanksgiving, early close'],
  ['2026-12-24 12:15', '2026-12-25 17:00', 'Christmas'],
  ['2026-12-31 17:00', '2027-01-01 17:00', "New Year's Day"],
  ['2027-01-18 12:00', '2027-01-18 17:00', 'Martin Luther King Jr. Day'],
  ['2027-02-15 12:00', '2027-02-15 17:00', "Presidents' Day"],
  ['2027-03-25 17:00', '2027-03-26 17:00', 'Good Friday'],
  ['2027-05-31 12:00', '2027-05-31 17:00', 'Memorial Day'],
  ['2027-06-18 12:00', '2027-06-18 17:00', 'Juneteenth, observed'],
  ['2027-07-05 12:00', '2027-07-05 17:00', 'Independence Day, observed'],
  ['2027-09-06 12:00', '2027-09-06 17:00', 'Labor Day'],
  ['2027-11-25 12:00', '2027-11-25 17:00', 'Thanksgiving'],
  ['2027-11-26 12:15', '2027-11-26 17:00', 'Day after Thanksgiving, early close'],
  ['2027-12-23 17:00', '2027-12-24 17:00', 'Christmas, observed'],
]

/** Zero-padded, so wall times compare as strings in time order. */
const pad = (value: number) => String(value).padStart(2, '0')

let formatter: Intl.DateTimeFormat | null = null

/** The exchange's wall clock at `ms`: weekday, date and hour. */
function exchangeClock(ms: number) {
  formatter ??= new Intl.DateTimeFormat('en-US', {
    timeZone: EXCHANGE,
    weekday: 'short',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  })
  const parts = formatter.formatToParts(new Date(ms))
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? ''
  const number = (type: Intl.DateTimeFormatPartTypes) => Number(read(type))
  return {
    weekday: read('weekday'),
    year: number('year'),
    month: number('month'),
    day: number('day'),
    // Some engines print midnight as 24 even with a 23-hour cycle.
    hour: number('hour') % 24,
    minute: number('minute'),
    second: number('second'),
  }
}

/**
 * True while the market is open: not the weekend, not the daily halt, and not
 * a holiday closure CME has published.
 */
export function isFuturesMarketOpen(now: number = Date.now()): boolean {
  const clock = exchangeClock(now)
  const { weekday, hour } = clock
  if (weekday === 'Sat') return false
  if (weekday === 'Sun' && hour < SESSION_OPEN_HOUR) return false
  if (weekday === 'Fri' && hour >= SESSION_CLOSE_HOUR) return false
  if (hour === SESSION_CLOSE_HOUR) return false
  const wall = `${clock.year}-${pad(clock.month)}-${pad(clock.day)} ${pad(hour)}:${pad(clock.minute)}`
  return !CME_HOLIDAY_CLOSURES.some(([from, until]) => wall >= from && wall < until)
}

/**
 * The open of the trading session `ms` falls in: the latest 17:00 Chicago at
 * or before it.
 *
 * Worked from the exchange's wall clock, then taken back to an instant with
 * the offset in force at `ms`. A session never straddles a clock change --
 * those fall at 02:00 on a Sunday, when the market is shut -- so the offset
 * at `ms` is the offset at its open too.
 */
export function sessionOpenAt(ms: number): number {
  const clock = exchangeClock(ms)
  const wall = Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute, clock.second)
  const offset = wall - Math.floor(ms / 1000) * 1000
  const day = Date.UTC(clock.year, clock.month - 1, clock.day)
  const openWall =
    clock.hour >= SESSION_OPEN_HOUR
      ? day + SESSION_OPEN_HOUR * HOUR_MS
      : day - DAY_MS + SESSION_OPEN_HOUR * HOUR_MS
  return openWall - offset
}

export interface SessionChange {
  /** The close the change is measured from. */
  reference: number
  percent: number
  /** What `reference` is, in words, for the tooltip. */
  since: string
}

/**
 * How far the last price has moved since the previous session closed.
 *
 * The legend printed the move over the whole loaded history -- "+9.57%" for
 * 180 days of hourly bars -- beside the live price, where every chart puts the
 * day's change, and nothing said which it was. Measured from the last bar
 * before the current session opened, which is the previous session's close
 * on an intraday or daily chart. A weekly or monthly bar spans many sessions,
 * so there it is the previous bar's close, and the tooltip says so.
 */
export function sessionChange(candles: Candle[], interval: Interval): SessionChange | null {
  const last = candles.at(-1)
  if (!last) return null
  const open = sessionOpenAt(last.time)
  let previous: Candle | undefined
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    if (candles[index].time < open) {
      previous = candles[index]
      break
    }
  }
  if (!previous || previous.close === 0) return null
  return {
    reference: previous.close,
    percent: ((last.close - previous.close) / previous.close) * 100,
    since:
      INTERVAL_MS[interval] > DAY_MS
        ? "since the previous bar's close"
        : "since the previous session's close",
  }
}
