/**
 * Keyboard for the chart surface.
 *
 * The case this file was written for is the Delete fallback. The backtest
 * ranges are painted on the drawing canvas and held in the drawing rail, but
 * they are not drawings -- so Delete, which only ever looked at
 * `selectedDrawingId`, did nothing to them. From the review call: *"I just
 * clicked on it and... can't be deleted, or even selected."*
 */

import { render } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { useDrawingShortcuts } from '@/hooks/useDrawingShortcuts'
import { useWorkspace } from '@/store/workspace'
import type { Drawing } from '@/types/drawing'

function Harness() {
  useDrawingShortcuts()
  return null
}

const level: Drawing = {
  id: 'level-1',
  kind: 'horizontal',
  symbol: 'NQ',
  color: '#818cf8',
  width: 2,
  createdAt: 0,
  price: 100,
}

const selection = {
  symbol: 'NQ',
  start_time: 1_000,
  end_time: 2_000,
  source_interval: '1h' as const,
}
const testWindow = { start_time: 1_000, end_time: 2_000 }

function press(key: string, target: EventTarget = window) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
}

describe('Delete on the chart surface', () => {
  beforeEach(() => {
    useWorkspace.setState({
      drawings: [],
      past: [],
      future: [],
      selectedDrawingId: null,
      selection: null,
      testWindow: null,
      tool: 'cursor',
    })
    render(<Harness />)
  })

  it('removes the selected drawing first', () => {
    useWorkspace.setState({ drawings: [level], selectedDrawingId: 'level-1', selection })

    press('Delete')

    expect(useWorkspace.getState().drawings).toEqual([])
    // The range is untouched: a drawing was picked, so that is what "delete"
    // meant.
    expect(useWorkspace.getState().selection).toEqual(selection)
  })

  it('falls through to the setup band when no drawing is picked', () => {
    useWorkspace.setState({ selection })

    press('Delete')

    expect(useWorkspace.getState().selection).toBeNull()
  })

  it('takes the setup before the test window, since it is drawn last', () => {
    useWorkspace.setState({ selection, testWindow })

    press('Delete')

    expect(useWorkspace.getState().selection).toBeNull()
    expect(useWorkspace.getState().testWindow).toEqual(testWindow)

    press('Delete')

    expect(useWorkspace.getState().testWindow).toBeNull()
  })

  it('clears the test window when it is the only range', () => {
    useWorkspace.setState({ testWindow })

    press('Backspace')

    expect(useWorkspace.getState().testWindow).toBeNull()
  })

  it('does nothing when the chart is empty', () => {
    press('Delete')

    expect(useWorkspace.getState().selection).toBeNull()
    expect(useWorkspace.getState().testWindow).toBeNull()
  })

  it('leaves the caret alone while something is being typed into', () => {
    // Backspace in a note or a number field deletes a character, and must
    // never reach the chart.
    useWorkspace.setState({ selection })
    const input = document.createElement('input')
    document.body.append(input)

    press('Backspace', input)

    expect(useWorkspace.getState().selection).toEqual(selection)
    input.remove()
  })
})
