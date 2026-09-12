/**
 * Gestures on the overlay.
 *
 * The chart itself is replaced by a handle whose conversions are the identity,
 * so a pointer at (100, 150) is time 100 at price 150 and every assertion can
 * be read directly. What is being tested is the gesture logic -- what counts
 * as a shape, what counts as a misfire, and what a drag does to an existing
 * drawing -- none of which needs real candles to be meaningful.
 */

import { fireEvent, render } from '@testing-library/react'
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

  const { container } = render(<ChartOverlay {...props} />)
  const canvas = container.querySelector('canvas') as HTMLCanvasElement
  return { ...props, canvas, container }
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
