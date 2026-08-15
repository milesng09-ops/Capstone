/**
 * Owns one Lightweight Charts instance and exposes it imperatively.
 *
 * The overlay that draws annotations needs to convert between market
 * coordinates and pixels on every pan, zoom and resize. Routing that through
 * React state would re-render the workspace on every mouse-wheel tick, so the
 * hook hands back a stable `ChartHandle` with conversion functions and a
 * subscribe/notify channel instead. React renders the panel; the canvas keeps
 * itself in sync.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type Logical,
  type LogicalRange,
  type UTCTimestamp,
} from 'lightweight-charts'

import {
  baseChartOptions,
  candlesToSeries,
  candlesToVolume,
  fromChartTime,
  logicalFromTime,
  readChartPalette,
  timeFromLogical,
  toChartTime,
  withAlpha,
  type ChartPalette,
} from '@/lib/chart'
import {
  broadcastCrosshair,
  broadcastLogicalRange,
  isApplyingSync,
  registerChart,
} from '@/lib/chartSync'
import type { Candle } from '@/types/market'

export interface ChartHandle {
  timeToX: (ms: number) => number | null
  priceToY: (price: number) => number | null
  xToTime: (x: number) => number | null
  yToPrice: (y: number) => number | null
  /**
   * Like `timeToX`/`xToTime`, but defined across the whole pane rather than
   * only where bars exist. Drawings use these so they can be placed in the
   * empty space beyond the first and last candle.
   */
  timeToXFree: (ms: number) => number | null
  xToTimeFree: (x: number) => number | null
  /** Called whenever the visible range or the element size changes. */
  subscribe: (listener: () => void) => () => void
  palette: () => ChartPalette
}

interface Options {
  /** Unique per panel; identifies the source of a sync broadcast. */
  id: string
  candles: Candle[]
  precision: number
  /** Notified as the pointer moves over bars, for the OHLC readout. */
  onHoverBar?: (candle: Candle | null) => void
}

export function useChartInstance({ id, candles, precision, onHoverBar }: Options) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const paletteRef = useRef<ChartPalette>(readChartPalette())
  const listenersRef = useRef(new Set<() => void>())
  const candlesRef = useRef<Candle[]>(candles)
  const hoverRef = useRef(onHoverBar)

  const [ready, setReady] = useState(false)

  candlesRef.current = candles
  hoverRef.current = onHoverBar

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) listener()
  }, [])

  // ---- create / destroy ------------------------------------------------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const palette = readChartPalette()
    paletteRef.current = palette

    const chart = createChart(container, {
      ...baseChartOptions(palette, precision),
      layout: {
        ...baseChartOptions(palette, precision).layout,
        background: { type: ColorType.Solid, color: 'transparent' },
      },
    })

    const series = chart.addCandlestickSeries({
      upColor: palette.bull,
      downColor: palette.bear,
      borderUpColor: palette.bull,
      borderDownColor: palette.bear,
      wickUpColor: palette.bull,
      wickDownColor: palette.bear,
      priceFormat: { type: 'price', precision, minMove: 1 / 10 ** precision },
    })

    const volume = chart.addHistogramSeries({
      priceFormat: { type: 'volume' },
      // An empty id makes this an overlay with its own hidden scale, so
      // volume never squashes the price axis.
      priceScaleId: '',
    })
    volume.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } })

    chartRef.current = chart
    seriesRef.current = series
    volumeRef.current = volume

    const timeScale = chart.timeScale()

    const handleRangeChange = (range: LogicalRange | null) => {
      notify()
      if (range && !isApplyingSync()) broadcastLogicalRange(id, range)
    }
    timeScale.subscribeVisibleLogicalRangeChange(handleRangeChange)

    const handleCrosshair = (param: { time?: unknown }) => {
      const time = typeof param.time === 'number' ? fromChartTime(param.time) : null
      if (!isApplyingSync()) broadcastCrosshair(id, time)

      const reporter = hoverRef.current
      if (reporter) {
        const found =
          time == null
            ? null
            : (candlesRef.current.find((candle) => candle.time === time) ?? null)
        reporter(found)
      }
    }
    chart.subscribeCrosshairMove(handleCrosshair)

    const unregister = registerChart(id, {
      applyCrosshair: (time) => {
        const target = seriesRef.current
        if (!target) return
        if (time == null) {
          chart.clearCrosshairPosition()
          return
        }
        const candle = candlesRef.current.find((item) => item.time === time)
        // Without a bar at that timestamp there is nothing honest to point
        // at, so leave the crosshair where it is rather than guessing.
        if (!candle) return
        chart.setCrosshairPosition(candle.close, toChartTime(time), target)
      },
      applyLogicalRange: (range) => {
        timeScale.setVisibleLogicalRange(range)
      },
    })

    const observer = new ResizeObserver(() => notify())
    observer.observe(container)

    setReady(true)
    notify()

    return () => {
      setReady(false)
      observer.disconnect()
      unregister()
      timeScale.unsubscribeVisibleLogicalRangeChange(handleRangeChange)
      chart.unsubscribeCrosshairMove(handleCrosshair)
      chart.remove()
      chartRef.current = null
      seriesRef.current = null
      volumeRef.current = null
    }
    // `precision` is instrument metadata and never changes for a mounted
    // panel; `id` is likewise fixed. Rebuilding on candle changes would throw
    // the user's zoom away on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, precision, notify])

  // ---- data ------------------------------------------------------------
  useEffect(() => {
    const series = seriesRef.current
    const volume = volumeRef.current
    if (!series || !volume) return

    const palette = paletteRef.current
    series.setData(candlesToSeries(candles))
    volume.setData(
      candlesToVolume(
        candles,
        withAlpha(palette.bull, 0.35),
        withAlpha(palette.bear, 0.35),
      ),
    )
    notify()
  }, [candles, notify, ready])

  // ---- stable handle ---------------------------------------------------
  const handleRef = useRef<ChartHandle>({
    timeToX: (ms) => {
      const chart = chartRef.current
      if (!chart) return null
      const x = chart.timeScale().timeToCoordinate(toChartTime(ms) as UTCTimestamp)
      return x == null ? null : Number(x)
    },
    priceToY: (price) => {
      const series = seriesRef.current
      if (!series) return null
      const y = series.priceToCoordinate(price)
      return y == null ? null : Number(y)
    },
    xToTime: (x) => {
      const chart = chartRef.current
      if (!chart) return null
      const time = chart.timeScale().coordinateToTime(x)
      return typeof time === 'number' ? fromChartTime(time) : null
    },
    timeToXFree: (ms) => {
      const chart = chartRef.current
      if (!chart) return null
      const timeScale = chart.timeScale()

      // A real bar converts directly and exactly; only fall back to the
      // logical scale for times the library has no bar for.
      const exact = timeScale.timeToCoordinate(toChartTime(ms) as UTCTimestamp)
      if (exact != null) return Number(exact)

      const logical = logicalFromTime(candlesRef.current, ms)
      if (logical == null) return null
      const coordinate = timeScale.logicalToCoordinate(logical as Logical)
      return coordinate == null ? null : Number(coordinate)
    },
    xToTimeFree: (x) => {
      const chart = chartRef.current
      if (!chart) return null
      // `coordinateToTime` returns null past the edges of the data, which is
      // what blocked drawing there. Logical coordinates stay defined.
      const logical = chart.timeScale().coordinateToLogical(x)
      if (logical == null) return null
      return timeFromLogical(candlesRef.current, Number(logical))
    },
    yToPrice: (y) => {
      const series = seriesRef.current
      if (!series) return null
      const price = series.coordinateToPrice(y)
      return price == null ? null : Number(price)
    },
    subscribe: (listener) => {
      listenersRef.current.add(listener)
      return () => {
        listenersRef.current.delete(listener)
      }
    },
    palette: () => paletteRef.current,
  })

  const fitContent = useCallback(() => {
    chartRef.current?.timeScale().fitContent()
  }, [])

  return { containerRef, handle: handleRef.current, ready, fitContent }
}
