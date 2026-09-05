/**
 * Undo behaviour for drawings.
 *
 * The store is exercised directly rather than through a component: undo is
 * about the sequence of edits, and a render adds nothing to that.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { longestRange, useWorkspace } from '@/store/workspace'
import type { Drawing } from '@/types/drawing'
import { DEFAULT_ICT_SETTINGS } from '@/types/ict'

function level(id: string, price = 100, symbol = 'NQ'): Drawing {
  return { id, kind: 'horizontal', symbol, color: '#818cf8', createdAt: 0, price }
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
