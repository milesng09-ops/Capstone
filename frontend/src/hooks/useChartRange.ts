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
 *
 * **The hour has to be watched, not just read.** `Date.now()` inside a memo is
 * only sampled when a dependency changes, so a window computed once at mount
 * would sit still while the market moved -- a session left open overnight
 * would still be charting yesterday. The bucket is therefore state, advanced
 * by a timer that fires on the hour, and it is the only thing besides the
 * range length that the window depends on.
 */

import { useEffect, useMemo, useState } from 'react'

import { useWorkspace } from '@/store/workspace'
import { MAX_RANGE_DAYS, type Interval } from '@/types/market'

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

/** Which hour it is, re-read as each one closes. */
function useHourBucket(): number {
  const [bucket, setBucket] = useState(() => Math.floor(Date.now() / HOUR_MS))

  useEffect(() => {
    // Scheduled to the boundary rather than polled, so the window turns over
    // when the hour does instead of up to an hour late.
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          setBucket(Math.floor(Date.now() / HOUR_MS))
          schedule()
        },
        HOUR_MS - (Date.now() % HOUR_MS) + 1_000,
      )
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [])

  return bucket
}

/**
 * The window to load, optionally held to what one interval can carry.
 *
 * The stored range is clamped against the *shared* interval, which is the
 * only one there is while the charts are linked. Unlinked, a pane may be on
 * something far finer -- 180 days of 1-minute bars is a request the backend
 * refuses outright -- so a pane passes its own interval and gets a window it
 * can actually load. Without the argument the behaviour is unchanged, which
 * is what the panels that are about the primary chart want.
 */
export function useChartRange(interval?: Interval): ChartRange {
  const rangeDays = useWorkspace((state) => state.rangeDays)
  const hour = useHourBucket()
  const days = interval ? Math.min(rangeDays, MAX_RANGE_DAYS[interval]) : rangeDays

  return useMemo(() => buildRange(days, hour * HOUR_MS), [days, hour])
}
