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

import { SegmentedControl } from '@/components/ui/fields'
import { RANGE_PRESETS, useWorkspace, type RangeDays } from '@/store/workspace'
import { TOOL_HINTS, TOOL_LABELS } from '@/types/drawing'

const DISCLAIMER =
  'Educational and research use only. Historical results do not guarantee future performance, and a backtest measures a rule against the past, not the market you will actually trade.'

export function StatusBar() {
  const rangeDays = useWorkspace((state) => state.rangeDays)
  const setRangeDays = useWorkspace((state) => state.setRangeDays)
  const tool = useWorkspace((state) => state.tool)

  return (
    <footer className="panel flex h-7 shrink-0 items-center gap-2 border-t border-border px-2">
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

      <p
        className="ml-auto hidden shrink truncate pl-2 text-2xs text-muted-foreground lg:block"
        title={DISCLAIMER}
      >
        {DISCLAIMER}
      </p>
    </footer>
  )
}
