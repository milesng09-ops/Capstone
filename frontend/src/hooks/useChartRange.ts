/**
 * The time window every chart and detector request shares.
 *
 * The end of the window is snapped **down to the hour** rather than being
 * `Date.now()`. Without that, the range changes on every render, every query
 * key changes with it, and the app refetches the entire history several times
 * a second. Snapped, the key only changes once an hour.
 *
 * **Why the hour, and not the interval's own bucket.** The window used to be
 * snapped to whichever interval was on screen, which meant switching from 1h
 * to 4h moved both ends of the range and so missed the cache -- three fresh
 * provider calls per symbol for bars the backend already held, against a quota
 * of five a minute. Every interval the app offers divides an hour evenly or is
 * built by aggregating hours, so one shared hourly window serves all of them
 * and a change of interval is answered from the cache. That is the difference
 * between changing timeframe being free and it costing most of a minute's
 * quota.
 *
 * The window runs to the *next* hour boundary so the bar currently forming is
 * always inside it. Asking for a little more than exists costs nothing: there
 * are no bars in the future to return.
 */

import { useMemo } from 'react'

import { useWorkspace } from '@/store/workspace'

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

export interface ChartRange {
  from: number
  to: number
}

export function buildRange(rangeDays: number, now = Date.now()): ChartRange {
  const to = Math.floor(now / HOUR_MS) * HOUR_MS + HOUR_MS
  return { from: to - rangeDays * DAY_MS, to }
}

export function useChartRange(): ChartRange {
  const rangeDays = useWorkspace((state) => state.rangeDays)

  return useMemo(() => buildRange(rangeDays), [rangeDays])
}
