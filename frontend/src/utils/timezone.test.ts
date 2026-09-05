import { describe, expect, it } from 'vitest'

import { formatClock, formatDateTime } from '@/utils/format'
import {
  DEFAULT_EXCHANGE_ZONE,
  EXCHANGE_TIME_ZONE,
  isKnownTimeZone,
  offsetLabel,
  offsetMinutes,
  resolveTimeZone,
} from '@/utils/timezone'

const JANUARY = Date.UTC(2026, 0, 15, 12, 0, 0)
const JULY = Date.UTC(2026, 6, 15, 12, 0, 0)

describe('offsetMinutes', () => {
  it('is zero for UTC', () => {
    expect(offsetMinutes('UTC', JANUARY)).toBe(0)
  })

  it('follows daylight saving rather than assuming a fixed offset', () => {
    expect(offsetMinutes('America/New_York', JANUARY)).toBe(-300)
    expect(offsetMinutes('America/New_York', JULY)).toBe(-240)
  })

  it('handles a zone ahead of UTC', () => {
    expect(offsetMinutes('Asia/Tokyo', JANUARY)).toBe(540)
  })
})

describe('offsetLabel', () => {
  it('prints UTC without a redundant zero offset', () => {
    expect(offsetLabel('UTC', JANUARY)).toBe('UTC')
    expect(offsetLabel('Europe/London', JANUARY)).toBe('UTC')
  })

  it('prints the sign and hour, the way charting platforms do', () => {
    expect(offsetLabel('America/New_York', JULY)).toBe('UTC-4')
    expect(offsetLabel('Asia/Tokyo', JANUARY)).toBe('UTC+9')
  })
})

describe('isKnownTimeZone', () => {
  it('rejects anything not offered in the picker', () => {
    expect(isKnownTimeZone('UTC')).toBe(true)
    expect(isKnownTimeZone('Mars/Olympus')).toBe(false)
    expect(isKnownTimeZone(undefined)).toBe(false)
  })
})

describe('formatting in a zone', () => {
  it('moves the printed hour, not the instant', () => {
    expect(formatClock(JANUARY, 'UTC')).toBe('12:00:00')
    expect(formatClock(JANUARY, 'America/New_York')).toBe('07:00:00')
  })

  it('rolls the date back when the zone is behind midnight', () => {
    const justAfterMidnightUtc = Date.UTC(2026, 0, 16, 0, 30, 0)
    expect(formatDateTime(justAfterMidnightUtc, 'UTC')).toContain('16 Jan 2026')
    expect(formatDateTime(justAfterMidnightUtc, 'America/New_York')).toContain(
      '15 Jan 2026',
    )
  })
})

describe('resolveTimeZone', () => {
  it('sends `exchange` to wherever the instrument trades', () => {
    expect(resolveTimeZone(EXCHANGE_TIME_ZONE, 'Europe/London')).toBe('Europe/London')
  })

  it('falls back to CME when the symbol list has not answered yet', () => {
    expect(resolveTimeZone(EXCHANGE_TIME_ZONE)).toBe(DEFAULT_EXCHANGE_ZONE)
  })

  it('passes a plain IANA zone through untouched', () => {
    expect(resolveTimeZone('Asia/Tokyo', 'Europe/London')).toBe('Asia/Tokyo')
  })
})
