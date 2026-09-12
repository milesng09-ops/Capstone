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
  /** Scroll so a given moment is in view, without changing the zoom. */
  jumpToTime: (time: number) => void
  /** Put the whole series back in view, on both axes. */
  resetView: () => void
}

/**
 * Which of the three links are live.
 *
 * A module variable rather than a hook, for the same reason the registry is:
 * crosshair movement fires on every mouse move, and reading a store from
 * inside that path would re-render the workspace dozens of times a second.
 * The store pushes changes in here instead.
 */
let modes = { interval: true, crosshair: true, time: true }

export function setSyncModes(next: {
  interval: boolean
  crosshair: boolean
  time: boolean
}): void {
  modes = next
}

export function syncModes(): { interval: boolean; crosshair: boolean; time: boolean } {
  return modes
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
  if (applying || !modes.crosshair) return
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
  if (applying || !modes.time) return
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

/**
 * Send every other chart to a moment in market time.
 *
 * Deliberately separate from the logical-range link, which matches *bar
 * indices*. Two markets do not hold the same number of bars -- on this
 * project's own cache ES held 2,967 hourly bars and NQ 2,965 -- so logical
 * index 100 is a different instant on each, and the drift grows with every
 * bar one vendor has and the other does not. Clicking a candle says "take me
 * to *this moment*", which is the question the index link cannot answer.
 */
export function broadcastTimeJump(sourceId: string, time: number): void {
  if (applying || !modes.time) return
  applying = true
  try {
    for (const [id, chart] of charts) {
      if (id === sourceId) continue
      chart.jumpToTime(time)
    }
  } finally {
    applying = false
  }
}

/**
 * Refit every chart.
 *
 * Unlike the two broadcasts above there is no source to exclude: a reset is
 * asked for once, by keyboard, and means all of the panes -- they are locked
 * to one another anyway, so refitting one and leaving the rest would only
 * pull them apart.
 */
export function resetAllCharts(): void {
  applying = true
  try {
    for (const chart of charts.values()) chart.resetView()
  } finally {
    applying = false
  }
}

/** True while a broadcast is in flight; used by charts to ignore echoes. */
export function isApplyingSync(): boolean {
  return applying
}
