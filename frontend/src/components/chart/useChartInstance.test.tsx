import { render } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { createChart } from 'lightweight-charts'
import { useChartInstance } from './useChartInstance'
import { DEFAULT_CHART_SETTINGS, type Candle } from '@/types/market'

vi.mock('lightweight-charts', () => ({ ColorType: { Solid: 'solid' }, createChart: vi.fn() }))

const instances: ReturnType<typeof chart>[] = []
function chart() {
  const priceScale = { applyOptions: vi.fn() }
  const series = { setData: vi.fn(), applyOptions: vi.fn(), priceScale: () => priceScale }
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
