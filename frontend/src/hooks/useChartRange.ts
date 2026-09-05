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

import { INTERVAL_ANCHOR_OFFSET_MS, INTERVAL_MS, type Interval } from '@/types/market'
import { useWorkspace } from '@/store/workspace'

const DAY_MS = 24 * 60 * 60 * 1000

export interface ChartRange {
  from: number
  to: number
}

export function buildRange(interval: Interval, rangeDays: number, now = Date.now()): ChartRange {
  const bucket = INTERVAL_MS[interval]
  // Buckets are anchored to the epoch plus an offset, not to the epoch
  // itself, so shift before snapping and shift back after. 4h bars open at
  // 02:00 UTC; snapping on a plain multiple would name a boundary no bar
  // actually starts on.
  const anchor = INTERVAL_ANCHOR_OFFSET_MS[interval]
  // One bucket past the current one, so the forming bar is still included.
  const to = Math.floor((now - anchor) / bucket) * bucket + anchor + bucket
  return { from: to - rangeDays * DAY_MS, to }
}

export function useChartRange(): ChartRange {
  const interval = useWorkspace((state) => state.interval)
  const rangeDays = useWorkspace((state) => state.rangeDays)

  return useMemo(() => buildRange(interval, rangeDays), [interval, rangeDays])
}
