/**
 * The strip along the bottom: how much history is loaded, what the held tool
 * does, and the disclaimer.
 *
 * The range presets belong down here next to the time axis they stretch, which
 * is the convention every charting platform settled on. The tool hint used to
 * be a banner that pushed the charts down each time a tool was picked; a fixed
 * strip says the same thing without the layout moving underneath the pointer.
 *
 * The disclaimer is last but not optional. This tool produces win rates from
 * historical data, and a number like that has to travel with the caveat that
 * it was measured against the past.
 */

import { useEffect, useState } from 'react'

import { SegmentedControl } from '@/components/ui/fields'
import { RANGE_PRESETS, useWorkspace, type RangeDays } from '@/store/workspace'
import { TOOL_HINTS, TOOL_LABELS } from '@/types/drawing'
import { formatClock } from '@/utils/format'
import { offsetLabel, TIME_ZONES, timeZoneLabel } from '@/utils/timezone'

const DISCLAIMER =
  'Educational and research use only. Historical results do not guarantee future performance, and a backtest measures a rule against the past, not the market you will actually trade.'

/** The same caveat, for a bar too narrow to finish the sentence. */
const SHORT_DISCLAIMER = 'Educational use only — past results are not future performance.'

/**
 * The running clock, and the zone every timestamp in the app is read against.
 *
 * It ticks for a reason beyond decoration. The same bar is a different hour to
 * a trader in London and one in Chicago, and a session boundary read off the
 * wrong clock is a wrong answer; a clock that moves says which one the charts
 * are using right now. The offset beside it is computed from the current
 * instant, so it follows the twice-yearly daylight-saving shift that a fixed
 * label would get wrong for weeks at a time.
 */
function Clock() {
  const timeZone = useWorkspace((state) => state.timeZone)
  const setTimeZone = useWorkspace((state) => state.setTimeZone)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    // Tick on the second boundary rather than every 1000ms from mount, so the
    // seconds never sit a fraction behind the wall clock they claim to show.
    let timer = 0
    const schedule = () => {
      timer = window.setTimeout(() => {
        setNow(Date.now())
        schedule()
      }, 1000 - (Date.now() % 1000))
    }
    schedule()
    return () => window.clearTimeout(timer)
  }, [])

  return (
    <div className="ml-auto flex shrink-0 items-center gap-1.5 pl-2">
      <span className="numeric text-2xs tabular-nums text-foreground">
        {formatClock(now, timeZone)}
      </span>
      <span className="text-2xs text-muted-foreground">{offsetLabel(timeZone, now)}</span>
      <select
        aria-label="Time zone"
        title={`Charts and timestamps are shown in ${timeZoneLabel(timeZone)}`}
        className="cursor-pointer rounded bg-transparent px-1 py-0.5 text-2xs text-muted-foreground outline-none hover:bg-secondary hover:text-foreground"
        value={timeZone}
        onChange={(event) => setTimeZone(event.target.value)}
      >
        {TIME_ZONES.map((zone) => (
          <option key={zone.value} value={zone.value}>
            {zone.label}
          </option>
        ))}
      </select>
    </div>
  )
}

export function StatusBar() {
  const rangeDays = useWorkspace((state) => state.rangeDays)
  const setRangeDays = useWorkspace((state) => state.setRangeDays)
  const tool = useWorkspace((state) => state.tool)

  return (
    <footer className="panel flex h-7 shrink-0 items-center gap-2 overflow-x-auto border-t border-border px-2">
      <span className="label-caps hidden sm:block">History</span>
      <SegmentedControl<string>
        variant="plain"
        value={String(rangeDays)}
        options={RANGE_PRESETS.map((days) => ({
          value: String(days),
          label: days >= 365 ? `${days / 365}y` : `${days}d`,
          title: `Load ${days} days of candles`,
        }))}
        onChange={(value) => setRangeDays(Number(value) as RangeDays)}
      />

      {tool !== 'cursor' && (
        <>
          <span className="bar-divider" />
          <p className="truncate text-2xs text-foreground">
            <span className="font-medium">{TOOL_LABELS[tool]}</span>
            <span className="text-muted-foreground"> — {TOOL_HINTS[tool]}</span>
          </p>
        </>
      )}

      {/*
       * Two lengths of the same caveat. The full sentence was being cut off
       * mid-clause below about 1200px -- a disclaimer truncated at "not the
       * market you will" is worse than a short one that finishes, so under
       * that width the short form runs instead and the full text stays on
       * the tooltip. It shortens; it never disappears.
       */}
      <p
        className="ml-auto hidden shrink truncate pl-2 text-2xs text-muted-foreground sm:block"
        title={DISCLAIMER}
      >
        <span className="xl:hidden">{SHORT_DISCLAIMER}</span>
        <span className="hidden xl:inline">{DISCLAIMER}</span>
      </p>

      <Clock />
    </footer>
  )
}
