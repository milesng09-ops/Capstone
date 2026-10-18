import { render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createChart } from 'lightweight-charts'
import { useChartInstance } from './useChartInstance'
import { DEFAULT_CHART_SETTINGS, type Candle } from '@/types/market'

vi.mock('lightweight-charts', () => ({ ColorType: { Solid: 'solid' }, createChart: vi.fn() }))

const instances: ReturnType<typeof chart>[] = []
function chart() {
  const priceScale = { applyOptions: vi.fn() }
  const primitives: Array<{ updateAllViews?: () => void }> = []
  const series = { setData: vi.fn(), applyOptions: vi.fn(), priceScale: () => priceScale,
    attachPrimitive: vi.fn((primitive: { updateAllViews?: () => void }) => primitives.push(primitive)),
    primitives }
  const volume = { setData: vi.fn(), applyOptions: vi.fn(), priceScale: () => priceScale }
  const timeScale = { fitContent: vi.fn(), subscribeVisibleLogicalRangeChange: vi.fn(),
    unsubscribeVisibleLogicalRangeChange: vi.fn() }
  return { addCandlestickSeries: () => series, addHistogramSeries: () => volume,
    timeScale: () => timeScale, subscribeCrosshairMove: vi.fn(), unsubscribeCrosshairMove: vi.fn(),
    subscribeClick: vi.fn(), unsubscribeClick: vi.fn(), applyOptions: vi.fn(), remove: vi.fn(),
    series, volume, scale: timeScale }
}

const candles: Candle[] = [{ symbol: 'ES', time: 1_780_000_000_000, open: 100,
  high: 102, low: 99, close: 101, volume: 10 }]
const settings = { ...DEFAULT_CHART_SETTINGS, bullColor: '#123456', bearColor: '#654321', showVolume: false }
function Harness({ id }: { id: string }) {
  const { containerRef } = useChartInstance({ id, candles, interval: '1h', precision: 2, settings })
  return <div ref={containerRef} />
}

beforeEach(() => {
  instances.length = 0
  vi.mocked(createChart).mockImplementation(() => {
    const instance = chart()
    instances.push(instance)
    return instance as unknown as ReturnType<typeof createChart>
  })
})

it('reapplies colours and volume when the symbol rebuilds the chart', () => {
  const view = render(<Harness id="ES" />)
  view.rerender(<Harness id="NQ" />)
  expect(instances).toHaveLength(2)
  expect(instances[1].series.applyOptions).toHaveBeenCalledWith(expect.objectContaining({
    upColor: '#123456', downColor: '#654321' }))
  expect(instances[1].volume.applyOptions).toHaveBeenCalledWith({ visible: false })
})

it('loads data and refits every new chart even when the interval stays the same', () => {
  const view = render(<Harness id="ES" />)
  view.rerender(<Harness id="NQ" />)
  expect(instances[1].series.setData).toHaveBeenCalled()
  expect(instances[1].scale.fitContent).toHaveBeenCalled()
})

const HOUR = 3_600_000
const hourly: Candle[] = [0, 1, 2, 3].map((index) => ({ symbol: 'ES', time: 1_780_000_000_000 + index * HOUR,
  open: 100, high: 102, low: 99, close: 101, volume: 10 }))

it('places a time between two bars between them, not at the left edge', () => {
  let handle: ReturnType<typeof useChartInstance>['handle'] | null = null
  function Probe() {
    const result = useChartInstance({ id: 'probe', candles: hourly, interval: '1h', precision: 2, settings })
    handle = result.handle
    return <div ref={result.containerRef} />
  }
  render(<Probe />)
  // Lightweight Charts answers 0 for any logical index that is not whole.
  Object.assign(instances[0].scale, {
    timeToCoordinate: () => null,
    logicalToCoordinate: (logical: number) => (Number.isInteger(logical) ? 100 + logical * 10 : 0),
  })
  expect(handle!.timeToXFree(hourly[1].time + HOUR / 2)).toBeCloseTo(115)
  expect(handle!.timeToXFree(hourly[3].time + 2 * HOUR)).toBeCloseTo(150)
  expect(handle!.timeToXFree(hourly[0].time - HOUR / 4)).toBeCloseTo(97.5)
})

it('keeps the volume off the price axis', () => {
  const add = vi.fn(() => instances.at(-1)!.volume)
  vi.mocked(createChart).mockImplementationOnce(() => {
    const instance = chart()
    instances.push(instance)
    return { ...instance, addHistogramSeries: add } as unknown as ReturnType<typeof createChart>
  })
  render(<Harness id="ES" />)
  expect(add).toHaveBeenCalledWith(expect.objectContaining({ lastValueVisible: false, priceLineVisible: false }))
})

it('refits once the new interval or span has its own bars, not on the outgoing ones', () => {
  function Pane(props: { interval: string; view: string; settled: boolean; bars: Candle[] }) {
    const { containerRef } = useChartInstance({ id: 'ES', precision: 2, settings, candles: props.bars,
      interval: props.interval, view: props.view, settled: props.settled })
    return <div ref={containerRef} />
  }
  const view = render(<Pane interval="1h" view="180d" settled bars={hourly} />)
  const fit = instances[0].scale.fitContent
  expect(fit).toHaveBeenCalledTimes(1)

  // 4h pressed: the query still shows the hourly bars as placeholder data.
  view.rerender(<Pane interval="4h" view="180d" settled={false} bars={hourly} />)
  expect(fit).toHaveBeenCalledTimes(1)
  view.rerender(<Pane interval="4h" view="180d" settled bars={hourly.slice(0, 2)} />)
  expect(fit).toHaveBeenCalledTimes(2)

  // A shorter history on the same interval reframes too...
  view.rerender(<Pane interval="4h" view="14d" settled={false} bars={hourly.slice(0, 2)} />)
  view.rerender(<Pane interval="4h" view="14d" settled bars={hourly.slice(0, 1)} />)
  expect(fit).toHaveBeenCalledTimes(3)
  // ...but a refetch of the same view keeps whatever zoom the user chose.
  view.rerender(<Pane interval="4h" view="14d" settled bars={[...hourly.slice(0, 1)]} />)
  expect(fit).toHaveBeenCalledTimes(3)
})

it('relabels the time axis for the new interval without rebuilding the chart', () => {
  // Daily bars open the evening before the day they trade, so their labels
  // depend on the interval; the axis has to follow it.
  function Pane({ interval }: { interval: string }) {
    const { containerRef } = useChartInstance({ id: 'axis', precision: 2, settings, candles, interval })
    return <div ref={containerRef} />
  }
  const view = render(<Pane interval="1h" />)
  const before = instances[0].applyOptions.mock.calls.length
  view.rerender(<Pane interval="1d" />)

  expect(instances).toHaveLength(1)
  expect(instances[0].applyOptions.mock.calls.length).toBeGreaterThan(before)
})

it('tells the overlay when only the price scale moves', () => {
  // Dragging the price axis changes no time range, so the range event never
  // fired and the drawings stayed at their old heights over moved candles.
  let handle: ReturnType<typeof useChartInstance>['handle'] | null = null
  function Probe() {
    const result = useChartInstance({ id: 'scale', candles: hourly, interval: '1h', precision: 2, settings })
    handle = result.handle
    return <div ref={result.containerRef} />
  }
  render(<Probe />)
  const listener = vi.fn()
  handle!.subscribe(listener)

  for (const primitive of instances[0].series.primitives) primitive.updateAllViews?.()
  expect(listener).toHaveBeenCalled()
})

it('places points off a single candle a bar of the interval apart', () => {
  // A monthly chart over a short history holds one candle; every point used
  // to collapse onto it, so nothing drawn there could be given any width.
  let handle: ReturnType<typeof useChartInstance>['handle'] | null = null
  function Probe() {
    const result = useChartInstance({ id: 'single', candles, interval: '1h', precision: 2, settings })
    handle = result.handle
    return <div ref={result.containerRef} />
  }
  render(<Probe />)
  Object.assign(instances[0].scale, {
    timeToCoordinate: () => null,
    logicalToCoordinate: (logical: number) => 100 + logical * 10,
    coordinateToLogical: (x: number) => (x - 100) / 10,
  })

  expect(handle!.timeToXFree(candles[0].time + 2 * HOUR)).toBeCloseTo(120)
  expect(handle!.xToTimeFree(130)).toBe(candles[0].time + 3 * HOUR)
})

it("hands a wheel event to the chart's own element and reports whether it was used", () => {
  // The overlay holds the pointer while a tool is held; the wheel it catches
  // is passed on so the chart still zooms about the pointer.
  let handle: ReturnType<typeof useChartInstance>['handle'] | null = null
  function Probe() {
    const result = useChartInstance({ id: 'wheel', candles: hourly, interval: '1h', precision: 2, settings })
    handle = result.handle
    return <div ref={result.containerRef} />
  }
  render(<Probe />)
  const root = document.createElement('div')
  const seen: WheelEvent[] = []
  root.addEventListener('wheel', (event) => {
    seen.push(event)
    event.preventDefault()
  })
  Object.assign(instances[0], { chartElement: () => root })

  const original = new WheelEvent('wheel', { deltaY: -120, clientX: 240, cancelable: true })
  expect(handle!.forwardWheel!(original)).toBe(true)
  expect(seen).toHaveLength(1)
  expect(seen[0]).not.toBe(original)
  expect([seen[0].deltaY, seen[0].clientX]).toEqual([-120, 240])
})
