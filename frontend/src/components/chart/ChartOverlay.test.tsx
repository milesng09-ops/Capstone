/**
 * Gestures on the overlay.
 *
 * The chart itself is replaced by a handle whose conversions are the identity,
 * so a pointer at (100, 150) is time 100 at price 150 and every assertion can
 * be read directly. What is being tested is the gesture logic -- what counts
 * as a shape, what counts as a misfire, and what a drag does to an existing
 * drawing -- none of which needs real candles to be meaningful.
 */

import { StrictMode } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ChartOverlay } from '@/components/chart/ChartOverlay'
import type { ChartHandle } from '@/components/chart/useChartInstance'
import { DEFAULT_ICT_SETTINGS } from '@/types/ict'
import type { Trade } from '@/types/backtest'
import type { Drawing } from '@/types/drawing'
import type { Candle } from '@/types/market'

// Far away from the pointer coordinates below, so nothing snaps to a bar and
// the identity conversions hold end to end.
const candles: Candle[] = [
  { symbol: 'NQ', time: 900_000, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
  { symbol: 'NQ', time: 903_600, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
]

/**
 * Bars sitting under the pointer coordinates, so that snapping is in play.
 * The default `candles` above are deliberately far away; these are for the
 * cases that are *about* the snap.
 */
const nearbyBars: Candle[] = [
  { symbol: 'NQ', time: 100, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
  { symbol: 'NQ', time: 500, open: 1, high: 2, low: 0.5, close: 1.5, volume: 1 },
]

const notifyListeners = new Set<() => void>()

const handle: ChartHandle = {
  timeToX: (ms) => ms,
  priceToY: (price) => price,
  xToTime: (x) => x,
  yToPrice: (y) => y,
  timeToXFree: (ms) => ms,
  xToTimeFree: (x) => x,
  subscribe: (listener: () => void) => {
    notifyListeners.add(listener)
    return () => notifyListeners.delete(listener)
  },
  palette: () => ({
    background: '#000000',
    text: '#ffffff',
    grid: '#111111',
    border: '#222222',
    bull: '#00ff00',
    bear: '#ff0000',
    accent: '#0000ff',
    muted: '#888888',
  }),
}

const level: Drawing = {
  id: 'level-1',
  kind: 'horizontal',
  symbol: 'NQ',
  color: '#818cf8',
  width: 2,
  createdAt: 0,
  price: 150,
}

function setup(overrides: Partial<Parameters<typeof ChartOverlay>[0]> = {}) {
  const props = {
    symbol: 'NQ',
    handle,
    candles,
    interval: '1h' as const,
    ict: undefined,
    ictSettings: DEFAULT_ICT_SETTINGS,
    drawings: [] as Drawing[],
    selection: null,
    testWindow: null,
    trades: [] as Trade[],
    selectedTradeId: null,
    evidence: null,
    tool: 'cursor' as const,
    drawingColor: '#818cf8',
    drawingWidth: 2,
    magnet: false,
    selectedDrawingId: null,
    snapToSwings: false,
    allowSelection: true,
    onCreateDrawing: vi.fn(),
    onUpdateDrawing: vi.fn(),
    onSelectDrawing: vi.fn(),
    onSelectionChange: vi.fn(),
    onTestWindowChange: vi.fn(),
    onSelectTrade: vi.fn(),
    onGestureComplete: vi.fn(),
    ...overrides,
  }

  const { container, rerender } = render(<ChartOverlay {...props} />)
  const canvas = container.querySelector('canvas') as HTMLCanvasElement
  return { ...props, canvas, container, rerender }
}

beforeAll(() => {
  // jsdom has no pointer capture; the gesture does not depend on it working,
  // only on it not throwing.
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
  Element.prototype.hasPointerCapture = vi.fn(() => false)
})

/**
 * jsdom implements no `PointerEvent`, and testing-library's fallback drops
 * `button` and the coordinates -- which are exactly what the handlers read.
 * A `MouseEvent` carries them and dispatches under the pointer event's name,
 * which is all React and the native listeners need.
 */
function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup',
  clientX: number,
  clientY: number,
): MouseEvent {
  return new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX,
    clientY,
  })
}

describe('placing a level', () => {
  it('commits on release, so the line is previewed before it exists', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'horizontal' })

    fireEvent(canvas, pointer('pointerdown', 100, 150))
    expect(onCreateDrawing).not.toHaveBeenCalled()

    fireEvent(canvas, pointer('pointerup', 100, 150))
    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'horizontal', price: 150 }),
    )
  })

  it('follows the pointer, so the level lands where it is released', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'horizontal' })

    fireEvent(canvas, pointer('pointerdown', 100, 150))
    fireEvent(canvas, pointer('pointermove', 100, 240))
    fireEvent(canvas, pointer('pointerup', 100, 240))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'horizontal', price: 240 }),
    )
  })

  it('is abandoned by Escape while the button is still down', () => {
    const { canvas, onCreateDrawing, onGestureComplete } = setup({ tool: 'horizontal' })

    fireEvent(canvas, pointer('pointerdown', 100, 150))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent(canvas, pointer('pointerup', 100, 150))

    expect(onCreateDrawing).not.toHaveBeenCalled()
    expect(onGestureComplete).toHaveBeenCalled()
  })
})

describe('drawing a shape', () => {
  it('abandons a two-click shape when the tool changes', () => {
    const props = setup({ tool: 'trendline' })
    fireEvent(props.canvas, pointer('pointerdown', 100, 100))
    fireEvent(props.canvas, pointer('pointerup', 100, 100))
    props.rerender(<ChartOverlay {...props} tool="rectangle" />)
    fireEvent(props.canvas, pointer('pointerdown', 200, 200))
    fireEvent(props.canvas, pointer('pointerup', 200, 200))
    expect(props.onCreateDrawing).not.toHaveBeenCalled()
  })

  it('does not consume Escape for a gesture abandoned on tool change', () => {
    const props = setup({ tool: 'trendline' })
    fireEvent(props.canvas, pointer('pointerdown', 100, 100))
    fireEvent(props.canvas, pointer('pointerup', 100, 100))
    props.rerender(<ChartOverlay {...props} tool="cursor" />)
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    expect(window.dispatchEvent(event)).toBe(true)
    expect(props.onGestureComplete).not.toHaveBeenCalled()
  })
  it('discards a click that never became a drag', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'trendline' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 101, 101))

    expect(onCreateDrawing).not.toHaveBeenCalled()
  })

  it('creates a trend line from a real drag', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'trendline' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 200, 160))
    fireEvent(canvas, pointer('pointerup', 200, 160))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'trendline',
        from: { time: 100, price: 100 },
        to: { time: 200, price: 160 },
      }),
    )
  })

  it('is abandoned by Escape mid-drag', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'trendline' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 200, 160))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent(canvas, pointer('pointerup', 200, 160))

    expect(onCreateDrawing).not.toHaveBeenCalled()
  })

  it('creates a zone from a drag with area', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 240, 180))
    fireEvent(canvas, pointer('pointerup', 240, 180))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'rectangle',
        from: { time: 100, price: 100 },
        to: { time: 240, price: 180 },
      }),
    )
  })

  it('refuses a zone whose sides collapse onto one bar once snapped', () => {
    // The bug from the 2026-09-05 review. The drag threshold is measured in
    // raw pixels *before* snapping, so a tall, narrow drag passes it and is
    // then stored with both sides on the same bar: no width, nothing painted,
    // yet still selected, still clickable and still listed. "This rectangular
    // shape is not showing... but this is able to be deleted."
    const { canvas, onCreateDrawing } = setup({ tool: 'rectangle', candles: nearbyBars })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 103, 300))
    fireEvent(canvas, pointer('pointerup', 103, 300))

    expect(onCreateDrawing).not.toHaveBeenCalled()
  })

  it('allows a thin zone, because a price band is a real annotation', () => {
    // The guard asks whether the shape covers any time and any price, not
    // whether it clears a pixel threshold -- otherwise the same drag would be
    // accepted at one zoom and refused at another.
    const { canvas, onCreateDrawing } = setup({ tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 400, 101))
    fireEvent(canvas, pointer('pointerup', 400, 101))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rectangle' }),
    )
  })

  it('abandons rather than commits when the browser takes the pointer', () => {
    // A pointercancel is an interruption, not a release. Running the commit
    // path on it placed a shape the user never finished drawing.
    const { canvas, onCreateDrawing, onGestureComplete } = setup({ tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 240, 180))
    fireEvent(canvas, new MouseEvent('pointercancel', { bubbles: true, cancelable: true }))

    expect(onCreateDrawing).not.toHaveBeenCalled()
    expect(onGestureComplete).toHaveBeenCalledWith(false)
  })

  it('arms on the first click instead of discarding it', () => {
    /*
     * Two-point shapes can be drawn either way: press-drag-release, or click
     * to drop the first point and click again to finish. The second is what
     * every charting platform does and is far easier over a long distance,
     * since it does not ask the hand to hold a button steady across half the
     * screen.
     *
     * Nothing is placed yet and nothing is abandoned, so the tool stays held
     * and no completion is reported either way.
     */
    const { canvas, onGestureComplete, onCreateDrawing } = setup({ tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 101, 101))

    expect(onCreateDrawing).not.toHaveBeenCalled()
    expect(onGestureComplete).not.toHaveBeenCalled()
  })

  it('places the shape on the second click', () => {
    const { canvas, onCreateDrawing, onGestureComplete } = setup({ tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 101, 101))
    fireEvent(canvas, pointer('pointermove', 240, 180))
    fireEvent(canvas, pointer('pointerdown', 240, 180))
    fireEvent(canvas, pointer('pointerup', 240, 180))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rectangle' }),
    )
    expect(onGestureComplete).toHaveBeenCalledWith(true)
  })

  it('still refuses a shape with no size, clicked twice in one spot', () => {
    // Arming must not become a way to store something invisible.
    const { canvas, onCreateDrawing, onGestureComplete } = setup({ tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 100, 100))
    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 100, 100))

    expect(onCreateDrawing).not.toHaveBeenCalled()
    expect(onGestureComplete).toHaveBeenCalledWith(false)
  })

  it('places a note where it is clicked', () => {
    // A point tool commits on the first release; it has one coordinate, so
    // pressing and releasing in place is the whole gesture.
    const { canvas, onCreateDrawing } = setup({ tool: 'text' })

    fireEvent(canvas, pointer('pointerdown', 150, 120))
    fireEvent(canvas, pointer('pointerup', 150, 120))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'text', text: expect.any(String) }),
    )
  })

  it('places a horizontal ray where it is clicked', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'horizontal_ray' })

    fireEvent(canvas, pointer('pointerdown', 150, 120))
    fireEvent(canvas, pointer('pointerup', 150, 120))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'horizontal_ray' }),
    )
  })

  it('places a time marker where it is clicked', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'vertical' })

    fireEvent(canvas, pointer('pointerdown', 150, 120))
    fireEvent(canvas, pointer('pointerup', 150, 120))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'vertical' }),
    )
  })

  it('releases the tool once a shape is actually placed', () => {
    const { canvas, onGestureComplete } = setup({ tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 240, 180))
    fireEvent(canvas, pointer('pointerup', 240, 180))

    expect(onGestureComplete).toHaveBeenCalledWith(true)
  })
})

describe('editing an existing drawing', () => {
  it('selects the drawing under the press', () => {
    const { container, onSelectDrawing } = setup({ drawings: [level] })

    fireEvent(container, pointer('pointerdown', 100, 150))
    expect(onSelectDrawing).toHaveBeenCalledWith('level-1')
  })

  it('clears the selection when the press lands on empty chart', () => {
    const { container, onSelectDrawing } = setup({ drawings: [level] })

    fireEvent(container, pointer('pointerdown', 100, 400))
    expect(onSelectDrawing).toHaveBeenCalledWith(null)
  })

  it('moves the drawing by the pointer delta', () => {
    const { container, onUpdateDrawing } = setup({ drawings: [level] })

    fireEvent(container, pointer('pointerdown', 100, 150))
    fireEvent(window, pointer('pointermove', 100, 200))
    fireEvent(window, pointer('pointerup', 100, 200))

    expect(onUpdateDrawing).toHaveBeenCalledWith(
      'level-1',
      expect.objectContaining({ price: 200 }),
    )
  })

  it('writes nothing when the press never moved, so a click costs no undo step', () => {
    const { container, onUpdateDrawing } = setup({ drawings: [level] })

    fireEvent(container, pointer('pointerdown', 100, 150))
    fireEvent(window, pointer('pointerup', 100, 150))

    expect(onUpdateDrawing).not.toHaveBeenCalled()
  })

  it('leaves the press alone when a tool is held, so it starts a new shape', () => {
    const { container, onSelectDrawing } = setup({
      drawings: [level],
      tool: 'trendline',
    })

    fireEvent(container, pointer('pointerdown', 100, 150))
    expect(onSelectDrawing).not.toHaveBeenCalled()
  })
})

describe('marking the range to test in', () => {
  it('commits a window from a drag across the candles', () => {
    const { canvas, onTestWindowChange } = setup({ tool: 'window' })

    fireEvent(canvas, pointer('pointerdown', 900_000, 100))
    fireEvent(canvas, pointer('pointermove', 903_600, 160))
    fireEvent(canvas, pointer('pointerup', 903_600, 160))

    // Snapped to the two bars, because a window the engine searches has to be
    // made of candles that exist.
    expect(onTestWindowChange).toHaveBeenCalledWith({
      start_time: 900_000,
      end_time: 903_600,
    })
  })

  it('orders the window when it is dragged right to left', () => {
    const { canvas, onTestWindowChange } = setup({ tool: 'window' })

    fireEvent(canvas, pointer('pointerdown', 903_600, 100))
    fireEvent(canvas, pointer('pointermove', 900_000, 160))
    fireEvent(canvas, pointer('pointerup', 900_000, 160))

    expect(onTestWindowChange).toHaveBeenCalledWith({
      start_time: 900_000,
      end_time: 903_600,
    })
  })

  it('does not set a selection, which is the other range entirely', () => {
    const { canvas, onSelectionChange } = setup({ tool: 'window' })

    fireEvent(canvas, pointer('pointerdown', 900_000, 100))
    fireEvent(canvas, pointer('pointermove', 903_600, 160))
    fireEvent(canvas, pointer('pointerup', 903_600, 160))

    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('is inert on a comparison chart, where a backtest never runs', () => {
    const { canvas, onTestWindowChange } = setup({ tool: 'window', allowSelection: false })

    fireEvent(canvas, pointer('pointerdown', 900_000, 100))
    fireEvent(canvas, pointer('pointermove', 903_600, 160))
    fireEvent(canvas, pointer('pointerup', 903_600, 160))

    expect(onTestWindowChange).not.toHaveBeenCalled()
  })

  it('is abandoned by Escape mid-drag', () => {
    const { canvas, onTestWindowChange } = setup({ tool: 'window' })

    fireEvent(canvas, pointer('pointerdown', 900_000, 100))
    fireEvent(canvas, pointer('pointermove', 903_600, 160))
    fireEvent.keyDown(window, { key: 'Escape' })
    fireEvent(canvas, pointer('pointerup', 903_600, 160))

    expect(onTestWindowChange).not.toHaveBeenCalled()
  })
})

describe('clicking a trade', () => {
  it('clears the selection on a click over empty chart', () => {
    const { container, onSelectTrade } = setup()

    fireEvent(container, pointer('pointerdown', 100, 400))
    fireEvent(window, pointer('pointerup', 100, 400))

    expect(onSelectTrade).toHaveBeenCalledWith(null)
  })

  it('selects nothing when the press panned the chart instead', () => {
    // A pan starts with the same press; only a release that never travelled
    // counts as a click.
    const { container, onSelectTrade } = setup()

    fireEvent(container, pointer('pointerdown', 100, 400))
    fireEvent(window, pointer('pointerup', 300, 400))

    expect(onSelectTrade).not.toHaveBeenCalled()
  })

  it('leaves the press to the drawing under it', () => {
    const { container, onSelectTrade } = setup({ drawings: [level] })

    fireEvent(container, pointer('pointerdown', 100, 150))
    fireEvent(window, pointer('pointerup', 100, 150))

    expect(onSelectTrade).not.toHaveBeenCalled()
  })
})

describe('repainting keeps up with the pointer', () => {
  /**
   * "It takes a minute to be there, and that's really annoying" -- from the
   * review call, about dragging the price scale.
   *
   * The chart notifies on every step of a pan, and a gesture adds its own
   * moves on top. Painting synchronously for each did the same work several
   * times inside one frame, none of which the screen ever showed.
   */
  beforeEach(() => {
    notifyListeners.clear()
  })

  it('collapses a burst of chart notifications into one repaint', async () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((cb) => {
        frames.push(cb)
        return frames.length
      })

    setup({ tool: 'cursor' })

    // Mounting schedules its own first paint. Run it, so the burst below is
    // measured from a clean slate rather than against a frame already latched.
    for (const frame of frames.splice(0)) frame(0)
    raf.mockClear()

    // Twenty notifications, as a single drag across the pane produces.
    const listener = [...notifyListeners][0]
    expect(listener).toBeTypeOf('function')
    for (let i = 0; i < 20; i += 1) listener()

    // One frame asked for, not twenty.
    expect(raf).toHaveBeenCalledTimes(1)

    // Once the frame runs, the next burst may ask for another.
    frames[0]?.(0)
    listener()
    expect(raf).toHaveBeenCalledTimes(2)

    raf.mockRestore()
  })
})

describe('taking a backtest range off the chart', () => {
  const selection = {
    symbol: 'NQ',
    start_time: 900_000,
    end_time: 903_600,
    source_interval: '1h' as const,
  }
  const testWindow = { start_time: 900_000, end_time: 903_600 }

  it('clears the setup when its tab is pressed', () => {
    const { canvas, onSelectionChange } = setup({ selection })

    canvas.parentElement!.dispatchEvent(pointer('pointerdown', 20, 12))

    expect(onSelectionChange).toHaveBeenCalledWith(null)
  })

  it('clears the test window from its own tab, not the setup', () => {
    const { canvas, onSelectionChange, onTestWindowChange } = setup({
      selection,
      testWindow,
    })

    canvas.parentElement!.dispatchEvent(pointer('pointerdown', 20, 30))

    expect(onTestWindowChange).toHaveBeenCalledWith(null)
    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('does not clear anything when the press lands elsewhere', () => {
    const { canvas, onSelectionChange } = setup({ selection })

    canvas.parentElement!.dispatchEvent(pointer('pointerdown', 300, 200))

    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('leaves a drawing under the tab alone', () => {
    // The tab is small and deliberately placed; losing it to whatever happens
    // to lie under the corner would put the user back where they started.
    const { canvas, onSelectionChange, onSelectDrawing } = setup({
      selection,
      drawings: [{ ...level, price: 12 }],
    })

    canvas.parentElement!.dispatchEvent(pointer('pointerdown', 20, 12))

    expect(onSelectionChange).toHaveBeenCalledWith(null)
    expect(onSelectDrawing).not.toHaveBeenCalled()
  })

  it('offers no tabs on a comparison chart, which defines no ranges', () => {
    const { canvas, onSelectionChange } = setup({ selection, allowSelection: false })

    canvas.parentElement!.dispatchEvent(pointer('pointerdown', 20, 12))

    expect(onSelectionChange).not.toHaveBeenCalled()
  })
})

/**
 * The one drawing a spy recorded.
 *
 * `setup` lets any callback be overridden, so the returned `onCreateDrawing`
 * is typed as the prop rather than as the mock. This asserts it is the spy
 * and hands back the draft, which is what the shape-specific cases read.
 */
function created(spy: unknown): any {
  const mock = spy as { mock?: { calls: unknown[][] } }
  expect(mock.mock?.calls.length).toBe(1)
  return mock.mock!.calls[0][0]
}

describe('the Fibonacci retracement', () => {
  it('is placed between the two swings that were dragged', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'fib' })

    fireEvent(canvas, pointer('pointerdown', 100, 300))
    fireEvent(canvas, pointer('pointermove', 400, 100))
    fireEvent(canvas, pointer('pointerup', 400, 100))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'fib',
        from: { time: 100, price: 300 },
        to: { time: 400, price: 100 },
      }),
    )
  })

  it('refuses a drag with no height, which would stack every level on one line', () => {
    const { canvas, onCreateDrawing, onGestureComplete } = setup({ tool: 'fib' })

    fireEvent(canvas, pointer('pointerdown', 100, 200))
    fireEvent(canvas, pointer('pointermove', 400, 200))
    fireEvent(canvas, pointer('pointerup', 400, 200))

    expect(onCreateDrawing).not.toHaveBeenCalled()
    // The tool stays held: the user was mid-gesture, not finished.
    expect(onGestureComplete).toHaveBeenCalledWith(false)
  })
})

describe('the position tools', () => {
  it('reads the drag as risk and places the target at twice it', () => {
    // Entry 200, dragged to 260: 60 of risk. A long's stop is below the
    // entry, so it lands at 140 and the target 120 above at 320.
    const { canvas, onCreateDrawing } = setup({ tool: 'long' })

    fireEvent(canvas, pointer('pointerdown', 100, 200))
    fireEvent(canvas, pointer('pointermove', 300, 260))
    fireEvent(canvas, pointer('pointerup', 300, 260))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'long',
        entry: { time: 100, price: 200 },
        stop: 140,
        target: 320,
      }),
    )
  })

  it('mirrors the whole trade for a short', () => {
    // Same gesture, opposite tool: the stop goes above the entry and the
    // target below it. The drag is read as a distance, so a trade drawn the
    // wrong way round still comes out as the trade that was asked for.
    const { canvas, onCreateDrawing } = setup({ tool: 'short' })

    fireEvent(canvas, pointer('pointerdown', 100, 200))
    fireEvent(canvas, pointer('pointermove', 300, 260))
    fireEvent(canvas, pointer('pointerup', 300, 260))

    expect(onCreateDrawing).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'short', stop: 260, target: 80 }),
    )
  })

  it('refuses a drag that sets no risk', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'long' })

    fireEvent(canvas, pointer('pointerdown', 100, 200))
    fireEvent(canvas, pointer('pointermove', 300, 200))
    fireEvent(canvas, pointer('pointerup', 300, 200))

    expect(onCreateDrawing).not.toHaveBeenCalled()
  })

  it('gives a box with no width a visible duration', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'long' })

    fireEvent(canvas, pointer('pointerdown', 500, 200))
    fireEvent(canvas, pointer('pointermove', 500, 260))
    fireEvent(canvas, pointer('pointerup', 500, 260))

    const drawn = created(onCreateDrawing)
    expect(drawn.endTime).toBeGreaterThan(drawn.entry.time)
  })
})

describe('the freehand brush', () => {
  it('stores the path the pointer took, not its two ends', () => {
    const { canvas, onCreateDrawing } = setup({ tool: 'brush' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 140, 130))
    fireEvent(canvas, pointer('pointermove', 180, 100))
    fireEvent(canvas, pointer('pointerup', 180, 100))

    const drawn = created(onCreateDrawing)
    expect(drawn.kind).toBe('brush')
    expect(drawn.points).toEqual([
      { time: 100, price: 100 },
      { time: 140, price: 130 },
      { time: 180, price: 100 },
    ])
  })

  it('thins samples closer together than the eye can use', () => {
    // A pointer stream is hundreds of samples a second; storing them all puts
    // a drawing in localStorage larger than the rest of the workspace.
    const { canvas, onCreateDrawing } = setup({ tool: 'brush' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 101, 100))
    fireEvent(canvas, pointer('pointermove', 102, 100))
    fireEvent(canvas, pointer('pointermove', 140, 100))
    fireEvent(canvas, pointer('pointerup', 140, 100))

    expect(created(onCreateDrawing).points).toEqual([
      { time: 100, price: 100 },
      { time: 140, price: 100 },
    ])
  })

  it('discards a press that never moved', () => {
    const { canvas, onCreateDrawing, onGestureComplete } = setup({ tool: 'brush' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 100, 100))

    expect(onCreateDrawing).not.toHaveBeenCalled()
    expect(onGestureComplete).toHaveBeenCalledWith(false)
  })

  it('is not armed for a second click the way a two-point shape is', () => {
    // A freehand line has no "first point", so arming one would leave the
    // tool waiting for a click that means nothing.
    const { canvas, onGestureComplete } = setup({ tool: 'brush' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 100, 100))
    fireEvent(canvas, pointer('pointerdown', 200, 200))
    fireEvent(canvas, pointer('pointerup', 200, 200))

    expect(onGestureComplete).toHaveBeenCalledTimes(2)
  })
})

describe('the size of the surface', () => {
  /*
   * The overlay is only as useful as it is big. These assert that how big it
   * is comes from CSS and not from having painted, because a canvas is a
   * replaced element: `inset-0` alone leaves it at its intrinsic 300x150
   * instead of stretching, which the equivalent rule on a div would not do.
   *
   * jsdom reproduces the failing condition for free -- it computes no layout,
   * so `parent.clientWidth` is 0 and `draw` returns before it sizes anything,
   * exactly as it does in a real tab whose frames are never painted.
   */
  it('carries its own size, so it covers the pane before the first paint', () => {
    const { canvas } = setup({ tool: 'trendline' })

    expect(canvas.className).toContain('h-full')
    expect(canvas.className).toContain('w-full')
  })

  it('does not take its size from the paint loop', () => {
    // The regression: `draw` assigned `style.width`/`style.height`, so the
    // element was pane-sized only as a side effect of a frame being painted.
    // Load the app in a background tab and no frame ever arrives, leaving the
    // overlay 300x150 in the top-left corner -- the drawing tools answered the
    // pointer inside that square and a drag anywhere else panned the chart.
    const { canvas } = setup({ tool: 'trendline' })

    expect(canvas.style.width).toBe('')
    expect(canvas.style.height).toBe('')
  })
})

describe('painting under StrictMode', () => {
  it('still paints after React mounts it, tears it down and mounts it again', () => {
    // A frame queue that honours cancellation, as the browser does. The bug
    // lived in exactly that: the remount found a cancelled frame's handle
    // still in its ref, took it for a paint on its way, and never asked again.
    const frames = new Map<number, FrameRequestCallback>()
    let next = 0
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      next += 1
      frames.set(next, callback)
      return next
    })
    const caf = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      frames.delete(id)
    })

    try {
      const { container } = render(
        <StrictMode>
          <div>
            <ChartOverlay
              symbol="NQ"
              handle={handle}
              candles={candles}
              interval="1h"
              ict={undefined}
              ictSettings={DEFAULT_ICT_SETTINGS}
              drawings={[level]}
              selection={null}
              testWindow={null}
              trades={[]}
              selectedTradeId={null}
              evidence={null}
              tool="cursor"
              drawingColor="#818cf8"
              drawingWidth={2}
              magnet={false}
              selectedDrawingId={null}
              snapToSwings={false}
              allowSelection
              onCreateDrawing={vi.fn()}
              onUpdateDrawing={vi.fn()}
              onSelectDrawing={vi.fn()}
              onSelectionChange={vi.fn()}
              onTestWindowChange={vi.fn()}
              onSelectTrade={vi.fn()}
              onGestureComplete={vi.fn()}
            />
          </div>
        </StrictMode>,
      )
      const canvas = container.querySelector('canvas') as HTMLCanvasElement
      Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 640 })
      Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 320 })

      // The chart reporting a pan is a request for a paint.
      act(() => {
        for (const listener of notifyListeners) listener()
      })
      act(() => {
        for (const [id, callback] of [...frames]) {
          frames.delete(id)
          callback(0)
        }
      })

      // Sized to the pane: the paint ran, rather than the 300x150 default.
      expect(canvas.width).toBe(640 * (window.devicePixelRatio || 1))
    } finally {
      raf.mockRestore()
      caf.mockRestore()
    }
  })
})

describe('bug hunt, 18 Oct', () => {
  const selection = {
    symbol: 'NQ',
    start_time: 900_000,
    end_time: 903_600,
    source_interval: '1h' as const,
  }

  it('does not finish an armed shape on a right-click, which is for the menu', () => {
    const { canvas, onCreateDrawing, onGestureComplete } = setup({ tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 101, 101))
    fireEvent(canvas, pointer('pointermove', 240, 180))
    fireEvent(
      canvas,
      new MouseEvent('pointerup', { bubbles: true, button: 2, clientX: 240, clientY: 180 }),
    )

    expect(onCreateDrawing).not.toHaveBeenCalled()
    expect(onGestureComplete).not.toHaveBeenCalled()
  })

  it('drops an armed first point when the chart switches symbol', () => {
    // Left armed, the next click finished the old symbol's shape on the new
    // one, starting from the old symbol's price.
    const { canvas, container: _container, rerender, ...props } = setup({ tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 101, 101))
    rerender(<ChartOverlay {...props} symbol="YM" />)
    fireEvent(canvas, pointer('pointermove', 240, 180))
    fireEvent(canvas, pointer('pointerdown', 240, 180))
    fireEvent(canvas, pointer('pointerup', 240, 180))

    expect(props.onCreateDrawing).not.toHaveBeenCalled()
  })

  it('puts a drawing back when the browser takes the pointer mid-move', () => {
    const { container, onUpdateDrawing } = setup({ drawings: [level] })

    fireEvent(container, pointer('pointerdown', 100, 150))
    fireEvent(window, pointer('pointermove', 100, 200))
    fireEvent(window, new MouseEvent('pointercancel', { bubbles: true }))

    expect(onUpdateDrawing).not.toHaveBeenCalled()
  })

  it('ignores a press on the drawing toolbar, even between its buttons', () => {
    const { canvas, onSelectDrawing, onSelectTrade } = setup({ drawings: [level] })
    const toolbar = document.createElement('div')
    toolbar.setAttribute('role', 'toolbar')
    canvas.parentElement!.appendChild(toolbar)

    toolbar.dispatchEvent(pointer('pointerdown', 100, 150))
    window.dispatchEvent(pointer('pointerup', 100, 150))

    expect(onSelectDrawing).not.toHaveBeenCalled()
    expect(onSelectTrade).not.toHaveBeenCalled()
  })

  it('leaves a press on the axes to the chart, even over a drawing', () => {
    const plotted: ChartHandle = { ...handle, plotSize: () => ({ width: 300, height: 300 }) }
    const { container, onSelectDrawing } = setup({ handle: plotted, drawings: [level] })

    // The level runs the width of the pane at y=150; x=350 is the price axis.
    fireEvent(container, pointer('pointerdown', 350, 150))
    expect(onSelectDrawing).not.toHaveBeenCalled()

    fireEvent(container, pointer('pointerdown', 100, 150))
    expect(onSelectDrawing).toHaveBeenCalledWith('level-1')
  })

  it('puts the range tabs below the legend when told where it ends', () => {
    const { canvas, onSelectionChange } = setup({ selection, chipTop: 48 })

    canvas.parentElement!.dispatchEvent(pointer('pointerdown', 20, 12))
    expect(onSelectionChange).not.toHaveBeenCalled()

    canvas.parentElement!.dispatchEvent(pointer('pointerdown', 20, 54))
    expect(onSelectionChange).toHaveBeenCalledWith(null)
  })

  it('previews a freehand stroke along the path it took', () => {
    const lines: Array<[number, number]> = []
    const recorder: any = new Proxy(function () {}, {
      get: (_target, key) =>
        key === 'lineTo'
          ? (x: number, y: number) => {
              lines.push([x, y])
            }
          : key === 'measureText'
            ? () => ({ width: 10 })
            : recorder,
      apply: () => recorder,
      set: () => true,
    })
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    const context = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(recorder as CanvasRenderingContext2D)

    try {
      const { canvas } = setup({ tool: 'brush' })
      Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 640 })
      Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 320 })

      fireEvent(canvas, pointer('pointerdown', 100, 100))
      fireEvent(canvas, pointer('pointermove', 140, 130))
      fireEvent(canvas, pointer('pointermove', 180, 100))
      fireEvent(canvas, pointer('pointermove', 220, 140))
      lines.length = 0
      act(() => {
        for (const frame of frames.splice(0)) frame(0)
      })

      // The corners of the stroke, not one segment from the press.
      expect(lines).toEqual(expect.arrayContaining([[140, 130], [180, 100], [220, 140]]))
    } finally {
      raf.mockRestore()
      context.mockRestore()
    }
  })
})

describe('dragging one end of a line, with the magnet on', () => {
  // Bars at 100 and 500 whose four levels all sit between 0.5 and 2.
  const line: Drawing = {
    id: 'line',
    kind: 'trendline',
    symbol: 'NQ',
    color: '#818cf8',
    width: 2,
    createdAt: 0,
    from: { time: 100, price: 150 },
    to: { time: 500, price: 150 },
  }

  function dragEnd(toY: number) {
    const { container, onUpdateDrawing } = setup({
      candles: nearbyBars,
      drawings: [line],
      selectedDrawingId: 'line',
      magnet: true,
    })
    fireEvent(container, pointer('pointerdown', 500, 150))
    fireEvent(window, pointer('pointermove', 500, (150 + toY) / 2))
    fireEvent(window, pointer('pointermove', 500, toY))
    fireEvent(window, pointer('pointerup', 500, toY))
    const calls = vi.mocked(onUpdateDrawing).mock.calls
    return calls.at(-1)?.[1] as Drawing & { to: { price: number } }
  }

  it('follows the pointer when no level of the bar is near it', () => {
    // The strong magnet pinned the end to the bar's high (2) however far
    // above it the pointer was, so the end did not follow the hand.
    expect(dragEnd(120).to.price).toBe(120)
  })

  it('still lands exactly on a level the pointer is close to', () => {
    expect(dragEnd(8).to.price).toBe(2)
  })
})

describe('a held tool and the axes', () => {
  const plotted: ChartHandle = { ...handle, plotSize: () => ({ width: 300, height: 300 }) }

  it('does not start a shape on an axis', () => {
    const { canvas, onCreateDrawing } = setup({ handle: plotted, tool: 'horizontal' })

    // x=350 is over the price axis; y=320 over the time axis.
    fireEvent(canvas, pointer('pointerdown', 350, 150))
    fireEvent(canvas, pointer('pointerup', 350, 150))
    fireEvent(canvas, pointer('pointerdown', 100, 320))
    fireEvent(canvas, pointer('pointerup', 100, 320))

    expect(onCreateDrawing).not.toHaveBeenCalled()
  })

  it('stops a shape dragged off the candle area at its edge', () => {
    const { canvas, onCreateDrawing } = setup({ handle: plotted, tool: 'rectangle' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 360, 340))
    fireEvent(canvas, pointer('pointerup', 360, 340))

    const drawn = vi.mocked(onCreateDrawing).mock.calls[0][0] as { to: { time: number; price: number } }
    expect(drawn.to.price).toBe(300)
  })
})

/**
 * A canvas that records what was painted, and frames that run on demand.
 * The paint calls are the evidence for the cases about what is *shown*,
 * which no callback can reveal.
 */
function recording() {
  const calls = {
    fillRect: [] as number[][],
    lineTo: [] as number[][],
    fillText: [] as string[],
  }
  const recorder: any = new Proxy(function () {}, {
    get: (_target, key) => {
      if (key === 'fillRect') return (...args: number[]) => calls.fillRect.push(args)
      if (key === 'lineTo') return (...args: number[]) => calls.lineTo.push(args)
      if (key === 'fillText') return (text: string) => calls.fillText.push(text)
      if (key === 'measureText') return () => ({ width: 10 })
      return recorder
    },
    apply: () => recorder,
    set: () => true,
  })
  const frames: FrameRequestCallback[] = []
  const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
    frames.push(callback)
    return frames.length
  })
  const context = vi
    .spyOn(HTMLCanvasElement.prototype, 'getContext')
    .mockReturnValue(recorder as CanvasRenderingContext2D)

  return {
    calls,
    size(canvas: HTMLCanvasElement) {
      Object.defineProperty(canvas.parentElement, 'clientWidth', { value: 640 })
      Object.defineProperty(canvas.parentElement, 'clientHeight', { value: 320 })
    },
    paint() {
      for (const key of Object.keys(calls) as (keyof typeof calls)[]) calls[key].length = 0
      act(() => {
        for (const frame of frames.splice(0)) frame(0)
      })
    },
    restore() {
      raf.mockRestore()
      context.mockRestore()
    },
  }
}

describe('drawing audit, 18 Oct', () => {
  it('previews a position dragged to the left where the release will place it', () => {
    // The preview spanned the two pointer positions, behind the entry; the
    // release then placed a box ten bars ahead of it.
    const record = recording()
    try {
      const { canvas, onCreateDrawing } = setup({ tool: 'long' })
      record.size(canvas)
      fireEvent(canvas, pointer('pointerdown', 500, 200))
      fireEvent(canvas, pointer('pointermove', 300, 260))
      record.paint()

      const boxes = record.calls.fillRect.filter(([, , width]) => width > 0)
      expect(boxes.length).toBeGreaterThan(0)
      // Every part of the trade starts at the entry; nothing behind it.
      expect(boxes.every(([x]) => x === 500)).toBe(true)

      fireEvent(canvas, pointer('pointerup', 300, 260))
      const drawn = created(onCreateDrawing)
      expect(drawn.entry.time).toBe(500)
      expect(drawn.endTime).toBeGreaterThan(500)
    } finally {
      record.restore()
    }
  })

  it('keeps an armed shape armed when the second click lands on an axis', () => {
    const plotted: ChartHandle = { ...handle, plotSize: () => ({ width: 300, height: 300 }) }
    const { canvas, onCreateDrawing } = setup({ handle: plotted, tool: 'trendline' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointerup', 100, 100))
    fireEvent(canvas, pointer('pointermove', 290, 150))
    // x=340 is over the price axis: refused as a press, so not a finish.
    fireEvent(canvas, pointer('pointerdown', 340, 150))
    fireEvent(canvas, pointer('pointerup', 340, 150))
    expect(onCreateDrawing).not.toHaveBeenCalled()

    // Still armed: a click on the candles finishes it from the first point.
    fireEvent(canvas, pointer('pointermove', 250, 150))
    fireEvent(canvas, pointer('pointerdown', 250, 150))
    fireEvent(canvas, pointer('pointerup', 250, 150))
    expect(created(onCreateDrawing).from).toEqual({ time: 100, price: 100 })
  })

  it('drops a drag whose drawing changed under it, so an undo stays undone', () => {
    // Ctrl+Z with the button down: the store went back, then the release
    // wrote the drag's stale copy over it -- the undone colour came back.
    const { container, rerender, canvas: _canvas, ...props } = setup({ drawings: [level] })

    fireEvent(container, pointer('pointerdown', 100, 150))
    fireEvent(window, pointer('pointermove', 100, 200))
    rerender(<ChartOverlay {...props} drawings={[{ ...level, color: '#22d3ee' }]} />)
    fireEvent(window, pointer('pointermove', 100, 210))
    fireEvent(window, pointer('pointerup', 100, 210))

    expect(props.onUpdateDrawing).not.toHaveBeenCalled()
  })

  it('keeps a drag going while the drawing is untouched', () => {
    // Re-renders for any other reason -- the legend's hover readout -- hand
    // over a new array holding the same drawing, and must not end the drag.
    const { container, rerender, canvas: _canvas, ...props } = setup({ drawings: [level] })

    fireEvent(container, pointer('pointerdown', 100, 150))
    fireEvent(window, pointer('pointermove', 100, 200))
    rerender(<ChartOverlay {...props} drawings={[level]} />)
    fireEvent(window, pointer('pointerup', 100, 200))

    expect(props.onUpdateDrawing).toHaveBeenCalledWith(
      'level-1',
      expect.objectContaining({ price: 200 }),
    )
  })

  it('waits for the bars of the new interval before marking a setup', () => {
    const { canvas, onSelectionChange } = setup({ tool: 'select', rangesReady: false })

    fireEvent(canvas, pointer('pointerdown', 900_000, 100))
    fireEvent(canvas, pointer('pointermove', 903_600, 100))
    fireEvent(canvas, pointer('pointerup', 903_600, 100))

    expect(onSelectionChange).not.toHaveBeenCalled()
  })

  it('prints prices at the instrument precision, so YM reads in whole points', () => {
    const record = recording()
    try {
      const { canvas } = setup({
        drawings: [{ ...level, price: 42150.375 }],
        precision: 0,
      })
      record.size(canvas)
      record.paint()

      expect(record.calls.fillText).toContain('42150')
      expect(record.calls.fillText).not.toContain('42150.38')
    } finally {
      record.restore()
    }
  })

  it('runs a ray drawn right to left on past its second point', () => {
    const ray: Drawing = {
      id: 'ray',
      kind: 'ray',
      symbol: 'NQ',
      color: '#818cf8',
      width: 2,
      createdAt: 0,
      from: { time: 400, price: 100 },
      to: { time: 200, price: 150 },
    }
    const record = recording()
    try {
      const { canvas } = setup({ drawings: [ray] })
      record.size(canvas)
      record.paint()

      // Painted on to the left of x=200, keeping the slope.
      const ends = record.calls.lineTo.filter(([x]) => x < 0)
      expect(ends.length).toBe(1)
      const [x, y] = ends[0]
      expect((y - 100) / (x - 400)).toBeCloseTo(-0.25)
    } finally {
      record.restore()
    }
  })

  it('labels a position by its signed reward, not its distance', () => {
    // A long saved with its target under its entry: the old label measured
    // distances and called it a 2R trade.
    const inverted: Drawing = {
      id: 'long',
      kind: 'long',
      symbol: 'NQ',
      color: '#818cf8',
      width: 2,
      createdAt: 0,
      entry: { time: 100, price: 200 },
      endTime: 300,
      stop: 190,
      target: 180,
    }
    const record = recording()
    try {
      const { canvas } = setup({ drawings: [inverted] })
      record.size(canvas)
      record.paint()

      expect(record.calls.fillText).toContain('Long  -2.00R')
    } finally {
      record.restore()
    }
  })
})

describe("the chart's own controls while a tool is held", () => {
  const plotted: ChartHandle = { ...handle, plotSize: () => ({ width: 560, height: 290 }) }

  it('clips itself to the candle area, so the axes are hit on the chart', () => {
    // Covering the axes, the canvas took every press on them and refused it:
    // the scales could not be dragged until the tool was put down.
    const record = recording()
    try {
      const { canvas } = setup({ handle: plotted, tool: 'trendline' })
      record.size(canvas)
      record.paint()

      // 640x320 pane, 560x290 of candles: 80 of price axis, 30 of time axis.
      expect(canvas.style.clipPath).toBe('inset(0px 80px 30px 0px)')
    } finally {
      record.restore()
    }
  })

  it('takes the whole pane when the chart does not say where the candles end', () => {
    const record = recording()
    try {
      const { canvas } = setup({ tool: 'trendline' })
      record.size(canvas)
      record.paint()

      expect(canvas.style.clipPath).toBe('')
    } finally {
      record.restore()
    }
  })

  function wheel() {
    return new WheelEvent('wheel', { deltaY: -120, clientX: 200, bubbles: true, cancelable: true })
  }

  it('hands the wheel to the chart, which zooms as if the tool were down', () => {
    const forwardWheel = vi.fn(() => true)
    const { canvas } = setup({ handle: { ...handle, forwardWheel }, tool: 'trendline' })

    const event = wheel()
    canvas.dispatchEvent(event)

    expect(forwardWheel).toHaveBeenCalledWith(event)
    // Cancelled because the chart used it, as the chart cancels its own.
    expect(event.defaultPrevented).toBe(true)
  })

  it('leaves a wheel the chart did not use alone', () => {
    const forwardWheel = vi.fn(() => false)
    const { canvas } = setup({ handle: { ...handle, forwardWheel }, tool: 'trendline' })

    const event = wheel()
    canvas.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
  })

  it('stays out of the way with no tool held, when the wheel reaches the chart itself', () => {
    const forwardWheel = vi.fn(() => true)
    const { canvas } = setup({ handle: { ...handle, forwardWheel } })

    canvas.dispatchEvent(wheel())

    expect(forwardWheel).not.toHaveBeenCalled()
  })
})

describe('while the price is live', () => {
  // The candles are fetched again every minute while the market trades. A
  // refresh landing in the middle of a gesture must not cost the gesture.
  const refreshed: Candle[] = [
    ...candles,
    { symbol: 'NQ', time: 907_200, open: 1.5, high: 2.5, low: 1, close: 2, volume: 1 },
  ]

  it('keeps moving a drawing across a refresh of the candles', () => {
    const { container, rerender, canvas: _canvas, ...props } = setup({ drawings: [level] })

    fireEvent(container, pointer('pointerdown', 100, 150))
    fireEvent(window, pointer('pointermove', 100, 180))
    rerender(<ChartOverlay {...props} candles={refreshed} />)
    fireEvent(window, pointer('pointermove', 100, 200))
    fireEvent(window, pointer('pointerup', 100, 200))

    expect(props.onUpdateDrawing).toHaveBeenCalledWith(
      'level-1',
      expect.objectContaining({ price: 200 }),
    )
  })

  it('keeps a shape being drawn across a refresh of the candles', () => {
    const { canvas, rerender, container: _container, ...props } = setup({ tool: 'trendline' })

    fireEvent(canvas, pointer('pointerdown', 100, 100))
    fireEvent(canvas, pointer('pointermove', 200, 150))
    rerender(<ChartOverlay {...props} candles={refreshed} />)
    fireEvent(canvas, pointer('pointermove', 300, 200))
    fireEvent(canvas, pointer('pointerup', 300, 200))

    expect(created(props.onCreateDrawing).from).toEqual({ time: 100, price: 100 })
  })
})
