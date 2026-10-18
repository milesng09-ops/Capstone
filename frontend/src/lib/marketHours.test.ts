/**
 * The futures session, on the exchange's clock.
 *
 * Instants are written in UTC with the Chicago time beside them, in both
 * halves of the year: July is CDT (UTC-5) and January CST (UTC-6), and the
 * one rule has to land on 17:00 in Chicago either way.
 */

import { describe, expect, it } from 'vitest'

import { isFuturesMarketOpen, sessionChange, sessionOpenAt } from '@/lib/marketHours'
import type { Candle } from '@/types/market'

const utc = (iso: string) => Date.parse(`${iso}Z`)

describe('isFuturesMarketOpen', () => {
  it.each([
    ['2026-07-05T21:59', false, 'Sunday 16:59 CDT, before the open'],
    ['2026-07-05T22:00', true, 'Sunday 17:00 CDT, the open'],
    ['2026-07-08T20:59', true, 'Wednesday 15:59 CDT'],
    ['2026-07-08T21:30', false, 'Wednesday 16:30 CDT, the daily halt'],
    ['2026-07-08T22:00', true, 'Wednesday 17:00 CDT, after the halt'],
    ['2026-07-10T20:59', true, 'Friday 15:59 CDT'],
    ['2026-07-10T21:00', false, 'Friday 16:00 CDT, the close'],
    ['2026-07-11T17:00', false, 'Saturday noon'],
    ['2026-01-04T22:59', false, 'Sunday 16:59 CST'],
    ['2026-01-04T23:00', true, 'Sunday 17:00 CST'],
    ['2026-01-07T22:30', false, 'Wednesday 16:30 CST, the halt'],
  ])('%s is %s (%s)', (iso, open) => {
    expect(isFuturesMarketOpen(utc(iso))).toBe(open)
  })

  // CME's published holidays: the live chart polled every minute through them.
  it.each([
    ['2026-11-26T17:59', true, 'Thanksgiving 11:59 CST'],
    ['2026-11-26T18:00', false, 'Thanksgiving 12:00 CST, the halt'],
    ['2026-11-26T23:00', true, 'Thanksgiving 17:00 CST, the reopen'],
    ['2026-11-27T18:15', false, 'the day after, 12:15 CST, the early close'],
    ['2026-12-24T18:14', true, 'Christmas Eve 12:14 CST'],
    ['2026-12-24T18:15', false, 'Christmas Eve 12:15 CST, the early close'],
    ['2026-12-25T15:00', false, 'Christmas Day 09:00 CST'],
    ['2026-04-03T13:14', true, 'Good Friday 08:14 CDT, an abbreviated session'],
    ['2026-04-03T13:15', false, 'Good Friday 08:15 CDT, its close'],
    ['2025-07-04T15:00', true, 'Independence Day 2025, before the published span'],
  ])('%s is %s (%s)', (iso, open) => {
    expect(isFuturesMarketOpen(utc(iso))).toBe(open)
  })
})

describe('sessionOpenAt', () => {
  it('puts a Monday morning in the session that opened on Sunday evening', () => {
    expect(sessionOpenAt(utc('2026-07-06T15:00'))).toBe(utc('2026-07-05T22:00'))
  })

  it('puts a Monday evening in the session that opened at 17:00 that day', () => {
    expect(sessionOpenAt(utc('2026-07-06T23:00'))).toBe(utc('2026-07-06T22:00'))
    // Past midnight, still the session that opened the evening before.
    expect(sessionOpenAt(utc('2026-07-07T05:30'))).toBe(utc('2026-07-06T22:00'))
  })

  it('lands on 17:00 Chicago in winter too', () => {
    expect(sessionOpenAt(utc('2026-01-06T16:00'))).toBe(utc('2026-01-05T23:00'))
  })

  it('holds across the clock change, which falls while the market is shut', () => {
    // Clocks went forward at 02:00 on Sunday 8 March; the session opened at
    // 17:00 CDT that evening, 22:00 UTC.
    expect(sessionOpenAt(utc('2026-03-09T15:00'))).toBe(utc('2026-03-08T22:00'))
  })
})

function candle(iso: string, close: number): Candle {
  return { symbol: 'NQ', time: utc(iso), open: close, high: close, low: close, close, volume: 1 }
}

describe('sessionChange', () => {
  it("measures an intraday chart from the previous session's close", () => {
    const candles = [
      candle('2026-07-09T19:00', 90),
      // Thursday 15:00 CDT: the last bar before the 17:00 open.
      candle('2026-07-09T20:00', 100),
      candle('2026-07-09T22:00', 101),
      candle('2026-07-10T14:00', 102),
    ]
    const change = sessionChange(candles, '1h')

    expect(change?.reference).toBe(100)
    expect(change?.percent).toBeCloseTo(2)
    expect(change?.since).toBe("since the previous session's close")
  })

  it("measures a daily chart from the day before's close", () => {
    // Daily bars are stamped at the session open, 17:00 the evening before.
    const candles = [candle('2026-07-06T22:00', 100), candle('2026-07-07T22:00', 110)]
    expect(sessionChange(candles, '1d')?.percent).toBeCloseTo(10)
  })

  it("says a weekly chart is measured from the previous bar's close", () => {
    const candles = [candle('2026-06-28T22:00', 100), candle('2026-07-05T22:00', 105)]
    const change = sessionChange(candles, '1w')

    expect(change?.percent).toBeCloseTo(5)
    expect(change?.since).toBe("since the previous bar's close")
  })

  it('says nothing when the previous session is not loaded', () => {
    // A move "since" a close nobody has is a number made up for the space.
    expect(sessionChange([candle('2026-07-10T14:00', 102)], '1h')).toBeNull()
    expect(sessionChange([], '1h')).toBeNull()
  })
})
