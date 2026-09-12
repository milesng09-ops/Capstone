/**
 * Keyboard for the drawing tools.
 *
 * Bound to the window rather than to the chart, because the chart is a canvas
 * and never holds focus -- there is nothing to tab to. That makes it this
 * hook's job to stay out of the way of real inputs: while the caret is in a
 * text field, Backspace deletes a character and Escape closes a popover, and
 * neither should reach a drawing.
 *
 * Escape *during* a gesture is handled in `ChartOverlay`, which cancels the
 * shape being dragged and stops the event before it arrives here. What is
 * left for this hook is the resting case: drop the held tool, then clear the
 * selection.
 *
 * `R` resets the charts. It is here rather than on the chart for the same
 * reason as the rest: the canvas cannot hold focus, so there is nowhere else
 * for it to live.
 */

import { useEffect } from 'react'

import { resetAllCharts } from '@/lib/chartSync'
import { useWorkspace } from '@/store/workspace'

/** True when the keystroke belongs to whatever the user is typing into. */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  return ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

export function useDrawingShortcuts(): void {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return

      const state = useWorkspace.getState()
      // Ctrl on Windows and Linux, Cmd on macOS.
      const accel = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()

      if (accel && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) state.redoDrawings()
        else state.undoDrawings()
        return
      }

      // Ctrl+Y is the other redo people reach for on Windows.
      if (accel && key === 'y') {
        event.preventDefault()
        state.redoDrawings()
        return
      }

      if (event.key === 'Delete' || event.key === 'Backspace') {
        if (state.selectedDrawingId) {
          event.preventDefault()
          state.removeDrawing(state.selectedDrawingId)
          return
        }
        /*
         * With no drawing picked, Delete falls through to the backtest
         * ranges, newest first.
         *
         * They are painted on the same canvas and held in the same rail as
         * the drawings, so "get rid of this" is the same intent -- but they
         * are not drawings, nothing selects them, and Delete used to have
         * nothing to act on. That is the whole of *"I just clicked on it
         * and... can't be deleted, or even selected"* from the review call.
         * The setup goes before the window because it is the one that is
         * almost always drawn last.
         */
        if (state.selection) {
          event.preventDefault()
          state.setSelection(null)
          return
        }
        if (state.testWindow) {
          event.preventDefault()
          state.setTestWindow(null)
        }
        return
      }

      // Reset every chart. Unmodified, because it is the one thing you reach
      // for repeatedly while reading -- the same key TradingView binds it to.
      if (!accel && key === 'r') {
        event.preventDefault()
        resetAllCharts()
        return
      }

      if (event.key === 'Escape') {
        if (state.tool !== 'cursor') state.setTool('cursor')
        else if (state.selectedDrawingId) state.selectDrawing(null)
      }
    }

    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
    // Read through `getState` rather than subscribing: this listener is
    // attached once and never needs to re-bind as drawings change.
  }, [])
}
