/**
 * The three links between the charts.
 *
 * Miles asked for these separately -- interval, crosshair and time -- and was
 * specific that the crosshair is the one that matters most: reading an SMT
 * divergence means having the cursor on *the same candle* on NQ and on ES,
 * and without that you are comparing different moments and inventing
 * divergences that are not there.
 *
 * A toggle is only real if the broadcast actually stops, so that is what
 * these check, one link at a time.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LogicalRange } from 'lightweight-charts'

import {
  broadcastCrosshair,
  broadcastLogicalRange,
  broadcastTimeJump,
  registerChart,
  resetAllCharts,
  setSyncModes,
  withoutSync,
  type SyncedChart,
} from '@/lib/chartSync'

function chart(): SyncedChart & { calls: Record<string, unknown[][]> } {
  const calls: Record<string, unknown[][]> = {
    applyCrosshair: [],
    applyLogicalRange: [],
    jumpToTime: [],
    resetView: [],
  }
  return {
    calls,
    applyCrosshair: (time) => calls.applyCrosshair.push([time]),
    applyLogicalRange: (range) => calls.applyLogicalRange.push([range]),
    jumpToTime: (time) => calls.jumpToTime.push([time]),
    resetView: () => calls.resetView.push([]),
  }
}

const range = { from: 0, to: 100 } as LogicalRange

let a: ReturnType<typeof chart>
let b: ReturnType<typeof chart>
let detach: (() => void)[]

beforeEach(() => {
  detach.forEach((off) => off())
  detach = []
  a = chart()
  b = chart()
  detach.push(registerChart('a', a), registerChart('b', b))
  setSyncModes({ interval: true, crosshair: true, time: true })
})

// Assigned before the first `beforeEach` body runs.
detach = []

describe('with every link live', () => {
  it('moves the crosshair on the other charts, not on the source', () => {
    broadcastCrosshair('a', 1_000)

    expect(a.calls.applyCrosshair).toEqual([])
    expect(b.calls.applyCrosshair).toEqual([[1_000]])
  })

  it('does not bounce a broadcast back and forth', () => {
    // Setting the crosshair on B makes B emit its own move event, which
    // would otherwise come straight back to A.
    const echo: SyncedChart = {
      applyCrosshair: () => broadcastCrosshair('b', 5),
      applyLogicalRange: () => {},
      jumpToTime: () => {},
      resetView: () => {},
    }
    detach.push(registerChart('echo', echo))

    broadcastCrosshair('a', 1_000)

    expect(a.calls.applyCrosshair).toEqual([])
  })

  it('passes the scroll and zoom along', () => {
    broadcastLogicalRange('a', range)

    expect(b.calls.applyLogicalRange).toEqual([[range]])
  })

  it('sends the others to a clicked moment', () => {
    broadcastTimeJump('a', 1_700_000_000_000)

    expect(b.calls.jumpToTime).toEqual([[1_700_000_000_000]])
  })
})

describe('with the crosshair link off', () => {
  beforeEach(() => {
    setSyncModes({ interval: true, crosshair: false, time: true })
  })

  it('stops moving the other crosshairs', () => {
    broadcastCrosshair('a', 1_000)

    expect(b.calls.applyCrosshair).toEqual([])
  })

  it('leaves the scroll link alone', () => {
    // Three switches, three claims: turning one off must not quietly take
    // another with it.
    broadcastLogicalRange('a', range)

    expect(b.calls.applyLogicalRange).toEqual([[range]])
  })
})

describe('with the time link off', () => {
  beforeEach(() => {
    setSyncModes({ interval: true, crosshair: true, time: false })
  })

  it('stops passing the scroll along', () => {
    broadcastLogicalRange('a', range)

    expect(b.calls.applyLogicalRange).toEqual([])
  })

  it('stops the click from moving the other charts', () => {
    broadcastTimeJump('a', 1_700_000_000_000)

    expect(b.calls.jumpToTime).toEqual([])
  })

  it('leaves the crosshair link alone', () => {
    broadcastCrosshair('a', 1_000)

    expect(b.calls.applyCrosshair).toEqual([[1_000]])
  })
})

describe('resetting the view', () => {
  it('refits every chart, including the one that asked', () => {
    // Unlike the broadcasts there is no source to exclude: a reset is asked
    // for once, by keyboard, and means all of the panes.
    resetAllCharts()

    expect(a.calls.resetView).toHaveLength(1)
    expect(b.calls.resetView).toHaveLength(1)
  })

  it('still works with every link switched off', () => {
    // The links decide what the charts tell *each other*; a reset is a
    // direct instruction to all of them and is not one of those.
    setSyncModes({ interval: false, crosshair: false, time: false })

    resetAllCharts()

    expect(a.calls.resetView).toHaveLength(1)
  })
})

describe('a chart that has gone away', () => {
  it('stops being broadcast to', () => {
    const spy = vi.fn()
    const off = registerChart('c', { ...chart(), applyCrosshair: spy })

    broadcastCrosshair('a', 1)
    expect(spy).toHaveBeenCalledTimes(1)

    off()
    broadcastCrosshair('a', 2)
    expect(spy).toHaveBeenCalledTimes(1)
  })
})

describe('a refit', () => {
  it('does not reach the other charts', () => {
    /*
     * A refit is computed from the bars *this* chart holds, and a chart
     * changing interval holds different bars from its neighbour for as long
     * as the two fetches take to land. Broadcasting one puts a 25-bar weekly
     * range onto a chart still showing 2,900 hourly candles.
     *
     * Found by switching to the weekly view in the browser: both panes ended
     * up scrolled to a sliver at the right edge, and pressing R fixed them.
     */
    withoutSync(() => broadcastLogicalRange('a', range))

    expect(b.calls.applyLogicalRange).toEqual([])
  })

  it('leaves the link working afterwards', () => {
    withoutSync(() => broadcastLogicalRange('a', range))
    broadcastLogicalRange('a', range)

    expect(b.calls.applyLogicalRange).toEqual([[range]])
  })

  it('nests inside a reset of every chart', () => {
    // `resetAllCharts` suppresses for the whole sweep, and each chart's own
    // refit suppresses again inside it. Restoring rather than clearing is
    // what stops the inner one re-opening the link half way through.
    const inner: SyncedChart = {
      ...chart(),
      resetView: () => {
        withoutSync(() => {})
        broadcastLogicalRange('inner', range)
      },
    }
    detach.push(registerChart('inner', inner))

    resetAllCharts()

    expect(b.calls.applyLogicalRange).toEqual([])
  })
})
