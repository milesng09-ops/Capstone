/**
 * Undo behaviour for drawings.
 *
 * The store is exercised directly rather than through a component: undo is
 * about the sequence of edits, and a render adds nothing to that.
 */

import { beforeEach, describe, expect, it } from 'vitest'

import { useWorkspace } from '@/store/workspace'
import type { Drawing } from '@/types/drawing'

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
