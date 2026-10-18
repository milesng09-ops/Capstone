/**
 * The toolbar that floats over a selected drawing.
 *
 * Only the note's text box is tested here: what it owes the keyboard. A note
 * is dropped by a click and then typed into, and until the box took the
 * caret, typing went to the chart's own shortcuts instead.
 */

import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, it } from 'vitest'

import { DrawingActions } from '@/components/chart/DrawingActions'
import type { ChartHandle } from '@/components/chart/useChartInstance'
import { useWorkspace } from '@/store/workspace'
import type { TextDrawing } from '@/types/drawing'

const handle = {
  timeToXFree: () => 200,
  priceToY: () => 150,
  subscribe: () => () => {},
} as unknown as ChartHandle

function note(createdAt: number): TextDrawing {
  return {
    id: 'note',
    kind: 'text',
    symbol: 'NQ',
    color: '#818cf8',
    width: 2,
    createdAt,
    at: { time: 1_000, price: 100 },
    text: 'Note',
  }
}

function show(drawing: TextDrawing) {
  act(() => {
    useWorkspace.setState({ drawings: [drawing], selectedDrawingId: drawing.id })
  })
  render(<DrawingActions symbol="NQ" handle={handle} drawings={[drawing]} />)
  return screen.getByRole('textbox', { name: 'Note text' }) as HTMLInputElement
}

beforeEach(() => {
  act(() => {
    useWorkspace.setState({ drawings: [], selectedDrawingId: null, past: [], future: [] })
  })
})

it('puts the caret in a note just dropped, with its placeholder picked', () => {
  // Typed at the page, an F turned focus mode on, an R reset the charts and
  // a Backspace deleted the note.
  const input = show(note(Date.now()))

  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd]).toEqual([0, 4])
})

it('leaves the keyboard alone when an older note is picked', () => {
  // Picking an existing note and pressing Delete should still delete it.
  const input = show(note(Date.now() - 60_000))

  expect(document.activeElement).not.toBe(input)
})

it.each(['Enter', 'Escape'])('hands the keyboard back to the chart on %s', (key) => {
  // An older note, clicked into by hand, so the box has the caret either way.
  const input = show(note(Date.now() - 60_000))
  input.focus()
  expect(document.activeElement).toBe(input)

  fireEvent.keyDown(input, { key })

  expect(document.activeElement).not.toBe(input)
})
