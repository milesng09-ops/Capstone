/**
 * Keeps several charts locked to the same bar.
 *
 * Miles's workflow depends on this: to spot an SMT divergence you look at NQ
 * and ES side by side and need the cursor sitting on *the same candle* in
 * both, otherwise you are comparing different moments and inventing
 * divergences that are not there.
 *
 * The registry lives outside React on purpose. Crosshair movement fires on
 * every mouse move; routing that through component state would re-render the
 * whole workspace dozens of times a second. Charts register an imperative
 * handle here and talk to each other directly.
 *
 * Every broadcast carries its source id and is applied with an `applying`
 * guard, because setting the crosshair on chart B makes chart B emit its own
 * move event, which would otherwise bounce back and forth forever.
 */

import type { LogicalRange } from 'lightweight-charts'

export interface SyncedChart {
  /** Place the crosshair on a bar, or clear it when `time` is null. */
  applyCrosshair: (time: number | null) => void
  /** Match another chart's horizontal scroll and zoom. */
  applyLogicalRange: (range: LogicalRange) => void
}

const charts = new Map<string, SyncedChart>()

/** Set while a broadcast is being applied, to break the feedback loop. */
let applying = false

export function registerChart(id: string, handle: SyncedChart): () => void {
  charts.set(id, handle)
  return () => {
    charts.delete(id)
  }
}

export function broadcastCrosshair(sourceId: string, time: number | null): void {
  if (applying) return
  applying = true
  try {
    for (const [id, chart] of charts) {
      if (id === sourceId) continue
      chart.applyCrosshair(time)
    }
  } finally {
    applying = false
  }
}

export function broadcastLogicalRange(sourceId: string, range: LogicalRange): void {
  if (applying) return
  applying = true
  try {
    for (const [id, chart] of charts) {
      if (id === sourceId) continue
      chart.applyLogicalRange(range)
    }
  } finally {
    applying = false
  }
}

/** True while a broadcast is in flight; used by charts to ignore echoes. */
export function isApplyingSync(): boolean {
  return applying
}
