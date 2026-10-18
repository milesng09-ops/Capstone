/**
 * Numbers and dates as the panels print them.
 */

import { describe, expect, it } from 'vitest'

import {
  formatCurrency,
  formatDateTime,
  formatForInterval,
  formatInteger,
  formatNumber,
  formatPercent,
  formatPrice,
  formatTradingDay,
} from '@/utils/format'

describe('a value that rounds to zero', () => {
  it('prints as zero, not as a loss too small to state', () => {
    // A -0.0018% trade showed "-0.00%" in the trade table and on the chart.
    expect(formatPercent(-0.0018)).toBe('0.00%')
    expect(formatPercent(-0.0018, 1)).toBe('0.0%')
    expect(formatPercent(-0.0018, 2, false)).toBe('0.00%')
  })

  it('does not claim a gain either', () => {
    expect(formatPercent(0.0018)).toBe('0.00%')
  })

  it('is caught in every numeric formatter, not just the percentage', () => {
    expect(formatNumber(-0.001)).toBe('0.00')
    expect(formatCurrency(-0.004)).toBe('$0.00')
    expect(formatPrice(-0.001)).toBe('0.00')
    expect(formatInteger(-0.4)).toBe('0')
  })

  it('leaves a value that does not round to zero signed as before', () => {
    expect(formatPercent(-0.02)).toBe('-0.02%')
    expect(formatPercent(1.5)).toBe('+1.50%')
    expect(formatPercent(-1.5, 2, false)).toBe('-1.50%')
    expect(formatCurrency(-12.5)).toBe('-$12.50')
    expect(formatNumber(-0.006)).toBe('-0.01')
    expect(formatInteger(-2)).toBe('-2')
  })
})

describe('a bar time, by its interval', () => {
  // The backend's stamps: the 17:00 Chicago open on the evening before.
  const mondaySession = Date.UTC(2026, 9, 11, 22)
  const october = Date.UTC(2026, 8, 30, 22)

  it('names a daily or weekly bar by the day it trades', () => {
    expect(formatForInterval(mondaySession, '1d', 'America/Chicago')).toBe('12 Oct 2026')
    expect(formatForInterval(mondaySession, '1w', 'UTC')).toBe('12 Oct 2026')
  })

  it('names a monthly bar by its month', () => {
    expect(formatForInterval(october, '1mo', 'America/Chicago')).toBe('Oct 2026')
  })

  it('keeps an intraday bar as the moment it is', () => {
    expect(formatForInterval(mondaySession, '1h', 'America/Chicago')).toBe(
      formatDateTime(mondaySession, 'America/Chicago'),
    )
  })

  it('declines a time that is not one', () => {
    expect(formatTradingDay(Number.NaN, '1d')).toBe('--')
  })
})
