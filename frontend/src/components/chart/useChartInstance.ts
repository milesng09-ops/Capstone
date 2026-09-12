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
  candlesToSeries,
  candlesToVolume,
  fromChartTime,
  logicalFromTime,
  readChartPalette,
  chartOptions,
  timeAxisOptions,
  timeFromLogical,
  toChartTime,
  withAlpha,
  type ChartPalette,
} from '@/lib/chart'
import {
  broadcastCrosshair,
  broadcastLogicalRange,
  broadcastTimeJump,
  isApplyingSync,
  registerChart,
} from '@/lib/chartSync'
import { useTimeZone } from '@/store/workspace'
import type { Candle, ChartSettings } from '@/types/market'

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
  /** Refit when this changes: a new interval reframes the whole pane. */
  interval: string
  precision: number
  /** Notified as the pointer moves over bars, for the OHLC readout. */
  onHoverBar?: (candle: Candle | null) => void
  /** Grid, volume and candle colours. Applied live, never re-creating the chart. */
  settings: ChartSettings
}

export function useChartInstance({
  id,
  candles,
  interval,
  precision,
  onHoverBar,
  settings,
}: Options) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null)
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null)
  const paletteRef = useRef<ChartPalette>(readChartPalette())
  const listenersRef = useRef(new Set<() => void>())
  const candlesRef = useRef<Candle[]>(candles)
  const hoverRef = useRef(onHoverBar)
  // Read through a ref inside the create effect so changing a setting adjusts
  // the live chart rather than tearing it down and rebuilding it -- which
  // would drop the visible range and every drawing's place on screen.
  const settingsRef = useRef(settings)
  settingsRef.current = settings

  const timeZone = useTimeZone()
  const zoneRef = useRef(timeZone)

  const [ready, setReady] = useState(false)
  const resetViewRef = useRef<() => void>(() => {})

  candlesRef.current = candles
  hoverRef.current = onHoverBar
  zoneRef.current = timeZone

  const notify = useCallback(() => {
    for (const listener of listenersRef.current) listener()
  }, [])

  // ---- create / destroy ------------------------------------------------
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const palette = readChartPalette()
    paletteRef.current = palette

    const options = chartOptions(palette, precision, zoneRef.current, settingsRef.current.showGrid)
    const chart = createChart(container, {
      ...options,
      layout: {
        ...options.layout,
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

    // A click says "take me to this moment" -- which is not what the
    // logical-range link says, and is the one Miles asked for by name.
    const handleClick = (param: { time?: unknown }) => {
      if (typeof param.time !== 'number' || isApplyingSync()) return
      broadcastTimeJump(id, fromChartTime(param.time))
    }
    chart.subscribeClick(handleClick)

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
      /*
       * Scroll so a moment is centred, keeping the zoom.
       *
       * Resolved through this chart's *own* candles, which is the whole
       * point: the logical-range link matches bar indices, and two markets
       * do not hold the same number of bars, so the same index is a
       * different instant on each. Working from the timestamp puts both
       * panes on the same moment however far their bar counts have drifted.
       */
      jumpToTime: (time) => {
        const current = timeScale.getVisibleLogicalRange()
        const logical = logicalFromTime(candlesRef.current, time)
        if (!current || logical == null) return
        const span = current.to - current.from
        timeScale.setVisibleLogicalRange({
          from: (logical - span / 2) as Logical,
          to: (logical + span / 2) as Logical,
        })
      },
      // Through a ref because `resetView` is defined below this effect and
      // must not become one of its dependencies -- naming it here directly
      // would rebuild the chart, and with it the user's zoom, on every
      // render that changed the callback's identity.
      resetView: () => resetViewRef.current(),
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
      chart.unsubscribeClick(handleClick)
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

  // ---- time zone -------------------------------------------------------
  // Relabelling the axis is an options change rather than a rebuild, so the
  // zoom, the drawings and the data all stay exactly where they are.
  useEffect(() => {
    chartRef.current?.applyOptions(timeAxisOptions(timeZone))
  }, [timeZone, ready])

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

  // ---- appearance, applied live ---------------------------------------
  useEffect(() => {
    const chart = chartRef.current
    const series = seriesRef.current
    const volume = volumeRef.current
    if (!chart || !series) return

    const palette = paletteRef.current
    chart.applyOptions({
      grid: {
        vertLines: { visible: settings.showGrid },
        horzLines: { visible: settings.showGrid },
      },
    })

    // `null` means follow the theme, which keeps tracking light and dark; a
    // stored colour that merely matches today's theme would not.
    const bull = settings.bullColor ?? palette.bull
    const bear = settings.bearColor ?? palette.bear
    series.applyOptions({
      upColor: bull,
      downColor: bear,
      borderUpColor: bull,
      borderDownColor: bear,
      wickUpColor: bull,
      wickDownColor: bear,
    })

    volume?.applyOptions({ visible: settings.showVolume })
  }, [settings])

  /**
   * Put the whole series back in view, on both axes.
   *
   * `fitContent` alone is only half a reset, and the missing half is the one
   * that strands a chart. Dragging the price axis latches `autoScale: false`
   * on the price scale, and from then on every `setData` leaves the range
   * where the drag left it -- so switching to a coarser interval draws the
   * new candles against a scale fitted to the old ones, and there is nothing
   * on screen. Re-enabling autoscale is what makes this the button the user
   * asked for rather than one that fixes the axis they were not complaining
   * about.
   */
  const resetView = useCallback(() => {
    seriesRef.current?.priceScale().applyOptions({ autoScale: true })
    chartRef.current?.timeScale().fitContent()
  }, [])
  resetViewRef.current = resetView

  /**
   * Bar spacing belongs to the chart, not to the data, so it survives a change
   * of interval: the same pixels-per-bar that framed 500 hourly candles frames
   * 30 four-hour ones as a handful of giant bars off the edge of the pane.
   * Refitting on the changes that invalidate the view -- and not on a refetch,
   * which would throw away a zoom the user chose -- is what stops every
   * timeframe click needing a manual reset.
   *
   * Keyed on the *data*, not on the interval alone. The interval prop changes
   * as soon as the button is pressed, while the candles for it are still in
   * flight, so refitting there fits the outgoing series and then never runs
   * again once the real ones arrive -- leaving exactly the view it was meant
   * to fix. Waiting until the candles change and comparing against the last
   * interval actually fitted refits once, against the bars it is describing.
   */
  const fittedIntervalRef = useRef<string | null>(null)
  useEffect(() => {
    if (!ready || candles.length === 0) return
    if (fittedIntervalRef.current === interval) return
    fittedIntervalRef.current = interval
    resetView()
  }, [candles, interval, ready, resetView])

  return { containerRef, handle: handleRef.current, ready, resetView }
}