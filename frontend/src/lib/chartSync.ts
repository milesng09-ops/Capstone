/**
 * Locks several charts to the same bar, for as long as they are asked to be.
 *
 * Off by default. Each pane scrolls, zooms and carries its own crosshair on
 * its own, so looking closely at one market leaves the others exactly where
 * they were -- which is what Miles asked for, having found that zooming into
 * a setup on NQ hauled ES in with it.
 *
 * Switched on, this is what an SMT read needs: NQ and ES side by side with
 * the cursor sitting on *the same candle* in both, otherwise you are
 * comparing different moments and inventing divergences that are not there.
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

import { DEFAULT_CHART_SYNC, type ChartSync } from '@/types/market'

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
 *
 * Seeded from the shared default rather than written out a second time, so
 * the gap between this module loading and the store's first push cannot
 * broadcast a link the workspace never asked for.
 */
let modes: ChartSync = { ...DEFAULT_CHART_SYNC }

export function setSyncModes(next: ChartSync): void {
  modes = next
}

export function syncModes(): ChartSync {
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
 * asked for once, by keyboard, and means all of the panes. Nor does it read
 * the links, so an unlinked pane still answers -- `R` is a direct instruction
 * to every chart rather than one chart telling the others what it just did,
 * which is the only thing the links govern. A pane on its own has the button
 * in its legend.
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

/**
 * Run something without letting it reach the other charts.
 *
 * For a refit, which is the one operation that is emphatically *local*. A
 * refit computes a range from the bars this chart is holding, and a chart
 * changing interval holds different bars from its neighbour for as long as
 * the two fetches take to land -- so broadcasting one puts a 25-bar weekly
 * range onto a chart still showing 2,900 hourly candles, or the reverse.
 * Found by switching to the weekly view: both panes ended up scrolled to a
 * sliver at the right edge, and pressing R fixed them.
 *
 * The flag is saved and restored rather than cleared, so this nests inside
 * `resetAllCharts`, which sets it for the whole sweep.
 */
export function withoutSync<T>(run: () => T): T {
  const was = applying
  applying = true
  try {
    return run()
  } finally {
    applying = was
  }
}
