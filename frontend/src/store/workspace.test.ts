/**
 * Undo behaviour for drawings.
 *
 * The store is exercised directly rather than through a component: undo is
 * about the sequence of edits, and a render adds nothing to that.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { renderHook } from '@testing-library/react'

import {
  canReadBias,
  longestRange,
  migrateWorkspace,
  useSymbolInterval,
  useWorkspace,
} from '@/store/workspace'
import type { Drawing } from '@/types/drawing'
import {
  DEFAULT_CHART_SYNC,
  DEFAULT_FAVOURITE_INTERVALS,
  INTERVALS,
  MAX_RANGE_DAYS,
} from '@/types/market'
import { setSyncModes, syncModes } from '@/lib/chartSync'
import type { ChartSync, SymbolKey } from '@/types/market'

/**
 * What `useSymbolInterval` answers for one pane, right now.
 *
 * The hook itself is rendered rather than its rule being restated here: a
 * local copy of the logic would pass whether or not the component under the
 * chart agrees with it, which is the only thing worth knowing.
 */
function intervalFor(symbol: SymbolKey) {
  const { result, unmount } = renderHook(() => useSymbolInterval(symbol))
  const value = result.current
  unmount()
  return value
}
import { DEFAULT_ICT_SETTINGS, type IctSettings } from '@/types/ict'
import { DEFAULT_DETECTOR_FILTERS, type DetectorFilters } from '@/types/backtest'

function level(id: string, price = 100, symbol = 'NQ'): Drawing {
  return { id, kind: 'horizontal', symbol, color: '#818cf8',
  width: 2, createdAt: 0, price }
}

const ids = () => useWorkspace.getState().drawings.map((drawing) => drawing.id)

describe('drawing history', () => {
  beforeEach(() => {
    useWorkspace.setState({
      drawings: [],
      past: [],
      future: [],
      selectedDrawingId: null,
    })
  })

  it('starts with nothing to undo', () => {
    expect(useWorkspace.getState().past).toEqual([])
    // Undoing an empty history is a no-op rather than an error.
    useWorkspace.getState().undoDrawings()
    expect(ids()).toEqual([])
  })

  it('undoes and redoes an added drawing', () => {
    const store = useWorkspace.getState()
    store.addDrawing(level('a'))
    expect(ids()).toEqual(['a'])

    useWorkspace.getState().undoDrawings()
    expect(ids()).toEqual([])

    useWorkspace.getState().redoDrawings()
    expect(ids()).toEqual(['a'])
  })

  it('walks back through several edits in order', () => {
    const store = useWorkspace.getState()
    store.addDrawing(level('a'))
    useWorkspace.getState().addDrawing(level('b'))
    useWorkspace.getState().addDrawing(level('c'))

    useWorkspace.getState().undoDrawings()
    expect(ids()).toEqual(['a', 'b'])
    useWorkspace.getState().undoDrawings()
    expect(ids()).toEqual(['a'])
  })

  it('covers a move, and counts it as one step', () => {
    useWorkspace.getState().addDrawing(level('a', 100))
    useWorkspace.getState().updateDrawing('a', { price: 250 } as Partial<Drawing>)

    const moved = useWorkspace.getState().drawings[0]
    expect(moved.kind === 'horizontal' && moved.price).toBe(250)

    useWorkspace.getState().undoDrawings()
    const restored = useWorkspace.getState().drawings[0]
    expect(restored.kind === 'horizontal' && restored.price).toBe(100)
  })

  it('covers a delete and a clear', () => {
    useWorkspace.getState().addDrawing(level('a'))
    useWorkspace.getState().addDrawing(level('b'))

    useWorkspace.getState().removeDrawing('a')
    expect(ids()).toEqual(['b'])
    useWorkspace.getState().undoDrawings()
    expect(ids()).toEqual(['a', 'b'])

    useWorkspace.getState().clearDrawings()
    expect(ids()).toEqual([])
    useWorkspace.getState().undoDrawings()
    expect(ids()).toEqual(['a', 'b'])
  })

  it('drops the redo branch once a new edit is made', () => {
    useWorkspace.getState().addDrawing(level('a'))
    useWorkspace.getState().undoDrawings()
    expect(useWorkspace.getState().future).toHaveLength(1)

    useWorkspace.getState().addDrawing(level('b'))
    expect(useWorkspace.getState().future).toEqual([])

    // Redo must not resurrect 'a' from the abandoned branch.
    useWorkspace.getState().redoDrawings()
    expect(ids()).toEqual(['b'])
  })

  it('clears a selection that undo has removed from under it', () => {
    useWorkspace.getState().addDrawing(level('a'))
    expect(useWorkspace.getState().selectedDrawingId).toBe('a')

    useWorkspace.getState().undoDrawings()
    expect(useWorkspace.getState().selectedDrawingId).toBeNull()
  })

  it('keeps a selection that survives the step', () => {
    useWorkspace.getState().addDrawing(level('a'))
    useWorkspace.getState().addDrawing(level('b'))
    useWorkspace.getState().selectDrawing('a')

    // Undoing 'b' leaves 'a' on the chart, so it stays selected.
    useWorkspace.getState().undoDrawings()
    expect(ids()).toEqual(['a'])
    expect(useWorkspace.getState().selectedDrawingId).toBe('a')
  })

  it('caps the history rather than growing without bound', () => {
    for (let index = 0; index < 60; index += 1) {
      useWorkspace.getState().addDrawing(level(`d${index}`))
    }
    expect(useWorkspace.getState().past.length).toBeLessThanOrEqual(50)
  })
})

describe('the test window', () => {
  beforeEach(() => {
    useWorkspace.setState({ testWindow: null, selectedTradeId: null, activeBacktestId: null })
  })

  it('starts unset, meaning the whole loaded history', () => {
    expect(useWorkspace.getState().testWindow).toBeNull()
  })

  it('stores a window dragged right to left in order', () => {
    useWorkspace.getState().setTestWindow({ start_time: 500, end_time: 100 })
    expect(useWorkspace.getState().testWindow).toEqual({ start_time: 100, end_time: 500 })
  })

  it('can be cleared back to the whole history', () => {
    useWorkspace.getState().setTestWindow({ start_time: 100, end_time: 500 })
    useWorkspace.getState().setTestWindow(null)
    expect(useWorkspace.getState().testWindow).toBeNull()
  })
})

describe('trade selection', () => {
  beforeEach(() => {
    useWorkspace.setState({ selectedTradeId: null, activeBacktestId: null })
  })

  it('drops the selected trade when the run on screen changes', () => {
    // A trade id belongs to one run; carried across, it would highlight
    // nothing while claiming something was selected.
    useWorkspace.getState().selectTrade('trade-1')
    useWorkspace.getState().setActiveBacktestId('run-2')
    expect(useWorkspace.getState().selectedTradeId).toBeNull()
  })

  it('drops the selected trade when the charted instrument changes', () => {
    useWorkspace.setState({ primarySymbol: 'NQ' })
    useWorkspace.getState().selectTrade('trade-1')
    useWorkspace.getState().setPrimarySymbol('ES')
    expect(useWorkspace.getState().selectedTradeId).toBeNull()
  })
})

describe('overlay defaults', () => {
  it('paints no detections until asked, but still runs them', () => {
    // The clean chart Miles asked for: found either way, drawn only on
    // request, so the search is never silently weakened by hiding them.
    expect(DEFAULT_ICT_SETTINGS.enabled).toBe(true)
    expect(DEFAULT_ICT_SETTINGS.showSwings).toBe(false)
    expect(DEFAULT_ICT_SETTINGS.showGaps).toBe(false)
    expect(DEFAULT_ICT_SETTINGS.showSmt).toBe(false)
  })

  it('keeps the evidence for a selected trade on', () => {
    expect(DEFAULT_ICT_SETTINGS.showTradeEvidence).toBe(true)
  })
})

describe('how much history an interval can carry', () => {
  it('brings the range down when the interval can no longer hold it', () => {
    // 180 days of 5-minute bars is more than one request can carry, and the
    // backend refuses it outright. Before this, switching to 5m left every
    // chart showing an error until you worked out that the range -- not the
    // interval you had just pressed -- was the problem.
    useWorkspace.setState({ interval: '1h', rangeDays: 180 })
    useWorkspace.getState().setInterval('5m')

    expect(useWorkspace.getState().rangeDays).toBe(90)
  })

  it('leaves a range the new interval can carry alone', () => {
    useWorkspace.setState({ interval: '1h', rangeDays: 60 })
    useWorkspace.getState().setInterval('5m')

    expect(useWorkspace.getState().rangeDays).toBe(60)
  })

  it('does not widen the range again on the way back up', () => {
    // Coming back to 1h should not silently load six months the user never
    // asked for; widening is their call, and the presets are right there.
    useWorkspace.setState({ interval: '5m', rangeDays: 90 })
    useWorkspace.getState().setInterval('1h')

    expect(useWorkspace.getState().rangeDays).toBe(90)
  })

  it('refuses a preset the current interval cannot serve', () => {
    useWorkspace.setState({ interval: '5m', rangeDays: 30 })
    useWorkspace.getState().setRangeDays(365)

    expect(useWorkspace.getState().rangeDays).toBe(90)
  })

  it('names the longest preset each interval can serve', () => {
    expect(longestRange('5m')).toBe(90)
    expect(longestRange('15m')).toBe(180)
    expect(longestRange('1h')).toBe(730)
    expect(longestRange('1d')).toBe(730)
  })

  it('offers every interval a preset it can actually load', () => {
    // The guard that matters for the minute intervals: 1m runs out of stored
    // bars in three weeks, so without a preset below 30 days the shortest
    // offer would already be one the backend refuses -- a button that only
    // returns an error.
    for (const interval of INTERVALS) {
      expect(longestRange(interval)).toBeLessThanOrEqual(MAX_RANGE_DAYS[interval])
    }
  })

  it('holds the minute intervals to what the vendors keep', () => {
    expect(longestRange('1m')).toBe(7)
    expect(longestRange('2m')).toBe(14)
    expect(longestRange('90m')).toBe(180)
    expect(longestRange('1w')).toBe(730)
    expect(longestRange('1mo')).toBe(730)
  })

  it('brings a long range down when switching to a minute interval', () => {
    useWorkspace.setState({ interval: '1h', rangeDays: 730 })
    useWorkspace.getState().setInterval('1m')

    expect(useWorkspace.getState().rangeDays).toBe(7)
  })
})

describe('the interval link', () => {
  beforeEach(() => {
    useWorkspace.setState({
      interval: '1h',
      chartSync: DEFAULT_CHART_SYNC,
      intervalOverrides: {},
      primarySymbol: 'NQ',
    })
  })

  it('gives every chart the shared interval while it is linked', () => {
    useWorkspace.getState().setSymbolInterval('ES', '1w')

    // Stored, but not in effect: the link is what decides.
    expect(useWorkspace.getState().intervalOverrides.ES).toBe('1w')
    expect(intervalFor('ES')).toBe('1h')
  })

  it('lets each chart keep its own once the link is off', () => {
    useWorkspace.getState().setSymbolInterval('ES', '1w')
    useWorkspace.getState().updateChartSync({ interval: false })

    expect(intervalFor('ES')).toBe('1w')
    // A pane never set individually still follows the shared one.
    expect(intervalFor('NQ')).toBe('1h')
  })

  it('remembers each pane across a relink', () => {
    // Otherwise the arrangement is something you rebuild every time you
    // glance at the shared view.
    useWorkspace.getState().updateChartSync({ interval: false })
    useWorkspace.getState().setSymbolInterval('ES', '1w')
    useWorkspace.getState().updateChartSync({ interval: true })
    useWorkspace.getState().updateChartSync({ interval: false })

    expect(intervalFor('ES')).toBe('1w')
  })

  it('drops a selection when the primary chart changes interval', () => {
    // A selection names a run of candles at one bar size; it cannot survive
    // that bar size changing underneath it.
    useWorkspace.setState({
      selection: { symbol: 'NQ', start_time: 1, end_time: 2, source_interval: '1h' },
    })

    useWorkspace.getState().setSymbolInterval('ES', '1w')
    expect(useWorkspace.getState().selection).not.toBeNull()

    useWorkspace.getState().setSymbolInterval('NQ', '4h')
    expect(useWorkspace.getState().selection).toBeNull()
  })

  it('pushes the links to the broadcast layer, not just into state', () => {
    /*
     * The broadcasts read a module variable rather than the store, because
     * crosshair movement fires on every mouse move. A toggle that only
     * reached the store would be a switch that visibly did nothing.
     *
     * Switched *on*, and from a known-off starting point. The links now
     * default to off, so a test that turned one off and asserted `false`
     * asserted the state it started in: deleting the push from the store
     * left the whole suite green.
     */
    setSyncModes({ interval: true, crosshair: false, time: false })

    useWorkspace.getState().updateChartSync({ crosshair: true })

    expect(syncModes().crosshair).toBe(true)
  })
})

describe('pinned intervals', () => {
  beforeEach(() => {
    useWorkspace.setState({ favouriteIntervals: DEFAULT_FAVOURITE_INTERVALS })
  })

  const pinned = () => useWorkspace.getState().favouriteIntervals

  it('pins an interval into the canonical order, not the order it was pressed', () => {
    // A toolbar whose buttons sit in the order they happened to be added is
    // one you have to read every time instead of reaching for by position.
    useWorkspace.getState().toggleFavouriteInterval('1w')
    useWorkspace.getState().toggleFavouriteInterval('3m')

    expect(pinned()).toEqual(['3m', '5m', '15m', '1h', '4h', '1d', '1w'])
  })

  it('unpins one that is already there', () => {
    useWorkspace.getState().toggleFavouriteInterval('4h')

    expect(pinned()).toEqual(['5m', '15m', '1h', '1d'])
  })

  it('refuses to empty the row', () => {
    // With nothing pinned there is no button showing which interval is
    // current, so the bar reads as though none is selected.
    useWorkspace.setState({ favouriteIntervals: ['1h'] })
    useWorkspace.getState().toggleFavouriteInterval('1h')

    expect(pinned()).toEqual(['1h'])
  })
})

describe('layout', () => {
  /**
   * Read what actually reached storage, not what the setter left in memory.
   *
   * An in-memory round-trip passes whether or not the field is persisted, so
   * it cannot tell "remembered across sessions" from "remembered until
   * reload" -- which is the entire claim these make.
   */
  const stored = () => JSON.parse(localStorage.getItem('mrl.workspace') ?? '{}').state ?? {}

  it('writes a collapsed panel to storage, so it is not back next session', () => {
    useWorkspace.getState().setSidePanel(null)
    expect(useWorkspace.getState().sidePanel).toBeNull()
    expect(stored()).toHaveProperty('sidePanel', null)

    useWorkspace.getState().setSidePanel('analysis')
    expect(stored()).toHaveProperty('sidePanel', 'analysis')
  })

  it('writes a collapsed results pane to storage', () => {
    useWorkspace.getState().setResultsOpen(false)
    expect(stored()).toHaveProperty('resultsOpen', false)
  })

  it('writes where the dividers were left to storage', () => {
    useWorkspace.getState().setSidebarRatio(0.9)
    useWorkspace.getState().setChartRatio(0.7)

    expect(stored()).toHaveProperty('sidebarRatio', 0.9)
    expect(stored()).toHaveProperty('chartRatio', 0.7)
  })
})

describe('migrating a stored workspace', () => {
  it('fills settings added since the state was saved', () => {
    // The case that prompted this: a version-2 workspace predates the
    // liquidity settings, and a number field handed `undefined` is an
    // uncontrolled input showing nothing.
    const stored = {
      interval: '1h',
      rangeDays: 30,
      ict: {
        enabled: true,
        swingStrength: 4,
        minGapPercent: 0.2,
        includeFilledGaps: true,
        includeInvalidSmt: false,
        showSwings: true,
        showGaps: false,
        showSmt: false,
        showTradeEvidence: true,
      },
    }

    const migrated = migrateWorkspace(stored, 2) as { ict: IctSettings }

    expect(migrated.ict.liquidityTolerancePercent).toBe(
      DEFAULT_ICT_SETTINGS.liquidityTolerancePercent,
    )
    expect(migrated.ict.liquidityMinTouches).toBe(DEFAULT_ICT_SETTINGS.liquidityMinTouches)
    expect(migrated.ict.showLiquidity).toBe(false)
    expect(migrated.ict.includeSweptPools).toBe(true)
  })

  it('fills the detector filters too, not just the chart settings', () => {
    // Zustand merges shallowly, so every persisted *object* has this hazard.
    // `detectors` gained three keys in the same change as `ict`, and a
    // missing boolean reaches a switch as `undefined` -- which JSON.stringify
    // drops, so the gap survives every reload until the control is clicked.
    const stored = {
      detectors: {
        require_fair_value_gap: true,
        require_smt_divergence: false,
        require_swing_point: false,
        within_bars: 10,
        align_with_direction: true,
        swing_strength: 2,
      },
    }

    const migrated = migrateWorkspace(stored, 2) as { detectors: DetectorFilters }

    expect(migrated.detectors.require_liquidity_sweep).toBe(false)
    expect(migrated.detectors.gap_past_midpoint).toBe(false)
    expect(migrated.detectors.liquidity_tolerance_percent).toBe(
      DEFAULT_DETECTOR_FILTERS.liquidity_tolerance_percent,
    )
    expect(migrated.detectors.liquidity_min_touches).toBe(
      DEFAULT_DETECTOR_FILTERS.liquidity_min_touches,
    )
    // And the choice that was already there survives.
    expect(migrated.detectors.require_fair_value_gap).toBe(true)
  })

  it('does not overwrite a setting the user had already chosen', () => {
    // Defaults are merged *under* the stored object, so backfilling a new key
    // must not quietly reset an old one.
    const stored = {
      ict: { ...DEFAULT_ICT_SETTINGS, swingStrength: 7, showSwings: true },
    }

    const migrated = migrateWorkspace(stored, 2) as { ict: IctSettings }

    expect(migrated.ict.swingStrength).toBe(7)
    expect(migrated.ict.showSwings).toBe(true)
  })

  it('still turns the overlays off when coming from version 1', () => {
    const stored = {
      ict: { ...DEFAULT_ICT_SETTINGS, showSwings: true, showGaps: true, showSmt: true },
    }

    const migrated = migrateWorkspace(stored, 1) as { ict: IctSettings }

    expect(migrated.ict.showSwings).toBe(false)
    expect(migrated.ict.showGaps).toBe(false)
    expect(migrated.ict.showSmt).toBe(false)
    // And the new keys are filled on that path too.
    expect(migrated.ict.liquidityMinTouches).toBe(DEFAULT_ICT_SETTINGS.liquidityMinTouches)
  })

  it('unlinks the scroll and the crosshair once, coming from version 3', () => {
    /*
     * The trap this exists for: every version before 4 saved these as
     * `true`, and a stored preference outlives a change of default. Without
     * this the one person who has actually been using the app is the one
     * person for whom panning NQ still drags ES along -- the fix would look
     * like it had not landed.
     */
    const stored = { chartSync: { interval: true, crosshair: true, time: true } }

    const migrated = migrateWorkspace(stored, 3) as { chartSync: ChartSync }

    expect(migrated.chartSync.crosshair).toBe(false)
    expect(migrated.chartSync.time).toBe(false)
    // Bar size is a different claim and was not part of the complaint.
    expect(migrated.chartSync.interval).toBe(true)
  })

  it('keeps a link that was chosen after the default moved', () => {
    // Forced once, on the way past version 4 -- not on every load, or the
    // switch would be one you could never turn on.
    const stored = { chartSync: { interval: false, crosshair: true, time: true } }

    const migrated = migrateWorkspace(stored, 4) as { chartSync: ChartSync }

    expect(migrated.chartSync).toEqual({ interval: false, crosshair: true, time: true })
  })

  it('fills a link that was saved before the switch existed', () => {
    // `chartSync` is restored whole, like `ict` and `detectors`, so a
    // missing key reaches a switch as `undefined` -- an uncontrolled input
    // that stays wrong until it is clicked.
    const stored = { chartSync: { time: true } as unknown as ChartSync }

    const migrated = migrateWorkspace(stored, 4) as { chartSync: ChartSync }

    expect(migrated.chartSync.interval).toBe(DEFAULT_CHART_SYNC.interval)
    expect(migrated.chartSync.crosshair).toBe(DEFAULT_CHART_SYNC.crosshair)
  })

  it('unlinks a workspace that never stored the links at all', () => {
    const migrated = migrateWorkspace({ interval: '1h' }, 3) as { chartSync: ChartSync }

    expect(migrated.chartSync).toEqual({ interval: true, crosshair: false, time: false })
  })

  it('still clamps a range the interval cannot carry', () => {
    const migrated = migrateWorkspace({ interval: '5m', rangeDays: 180 }, 2) as {
      rangeDays: number
    }
    expect(migrated.rangeDays).toBe(longestRange('5m'))
  })

  it('passes undefined straight through', () => {
    expect(migrateWorkspace(undefined, 2)).toBeUndefined()
  })
})

describe('the timeframe a bias is read from', () => {
  beforeEach(() => {
    useWorkspace.setState({ interval: '1h', higherTimeframe: '4h' })
  })

  it('keeps itself strictly coarser than the interval being entered on', () => {
    // A "1h bias" on an hourly backtest is the same structure consulted
    // twice, and the backend refuses the run rather than pretending.
    useWorkspace.getState().setHigherTimeframe('1h')

    expect(useWorkspace.getState().higherTimeframe).toBe('90m')
  })

  it('is carried up when the entry interval overtakes it', () => {
    // The two are set from opposite ends of the screen, so neither control
    // can be relied on to notice the other moved.
    useWorkspace.getState().setInterval('1d')

    expect(useWorkspace.getState().higherTimeframe).toBe('1w')
  })

  it('leaves a choice that is already coarser alone', () => {
    useWorkspace.getState().setHigherTimeframe('1d')

    expect(useWorkspace.getState().higherTimeframe).toBe('1d')
  })

  it('knows when there is nothing above the interval to read', () => {
    expect(canReadBias('1h')).toBe(true)
    expect(canReadBias('1mo')).toBe(false)
  })

  it('backfills the new conditions onto a workspace saved before them', () => {
    // `detectors` is restored whole, so one stored before these existed comes
    // back without them -- and a missing boolean reaches a switch as
    // `undefined`, which JSON.stringify drops on the way out again.
    const stored = {
      detectors: {
        require_fair_value_gap: true,
        require_smt_divergence: false,
        require_swing_point: false,
        within_bars: 10,
        align_with_direction: true,
        swing_strength: 2,
      },
    }

    const migrated = migrateWorkspace(stored, 4) as { detectors: DetectorFilters }

    expect(migrated.detectors.require_higher_timeframe_bias).toBe(false)
    expect(migrated.detectors.entry_model).toBe('any')
    expect(migrated.detectors.sessions).toEqual([])
    expect(migrated.detectors.min_wick_ratio).toBe(DEFAULT_DETECTOR_FILTERS.min_wick_ratio)
    // And the choice that was already there survives.
    expect(migrated.detectors.require_fair_value_gap).toBe(true)
  })
})
