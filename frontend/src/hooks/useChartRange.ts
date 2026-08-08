/**
 * The time window every chart and detector request shares.
 *
 * The end of the window is snapped **down to the current interval bucket**
 * rather than being `Date.now()`. Without that, the range changes on every
 * render, every query key changes with it, and the app refetches the entire
 * history several times a second. Snapped, the key only changes when a new
 * bar actually opens.
 */

import { useMemo } from 'react'

import { INTERVAL_MS, type Interval } from '@/types/market'
import { useWorkspace } from '@/store/workspace'

const DAY_MS = 24 * 60 * 60 * 1000

export interface ChartRange {
  from: number
  to: number
}

export function buildRange(interval: Interval, rangeDays: number, now = Date.now()): ChartRange {
  const bucket = INTERVAL_MS[interval]
  // One bucket past the current one, so the forming bar is still included.
  const to = Math.floor(now / bucket) * bucket + bucket
  return { from: to - rangeDays * DAY_MS, to }
}

export function useChartRange(): ChartRange {
  const interval = useWorkspace((state) => state.interval)
  const rangeDays = useWorkspace((state) => state.rangeDays)

  return useMemo(() => buildRange(interval, rangeDays), [interval, rangeDays])
}
