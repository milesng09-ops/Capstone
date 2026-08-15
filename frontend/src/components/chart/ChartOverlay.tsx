/**
 * Everything drawn on top of the candles.
 *
 * Lightweight Charts has no drawing tools and no way to render arbitrary
 * shapes, so this is a plain `<canvas>` stretched over the chart that converts
 * market coordinates to pixels itself. It renders, back to front:
 *
 *   1. fair value gap zones
 *   2. the backtest selection band
 *   3. SMT divergence lines
 *   4. swing point markers
 *   5. user drawings (trend lines, levels, zones)
 *   6. the shape currently being dragged
 *
 * **Pointer ownership.** The canvas is `pointer-events: none` while the cursor
 * tool is active, so the chart keeps its own pan and zoom. It only takes the
 * mouse when a drawing tool is held. Selecting and deleting existing drawings
 * happens in the side list rather than by clicking the canvas, which keeps the
 * two input models from fighting over the same clicks.
 *
 * **Cross-interval survival.** Times that fall on the chart are snapped to the
 * nearest current bar, so a level drawn on the 1-hour chart still lands in the
 * right place after switching to 4-hour, where its exact timestamp may not be
 * a bar at all.
 *
 * **Drawing off the data.** Snapping applies only *within* the bar range.
 * Beyond either edge there is no bar to snap to, so the raw timestamp is kept
 * and converted through the chart's logical scale, which stays defined in
 * empty space. That is what lets a trend line be projected forward past the
 * last candle -- the ordinary way a level is drawn ahead of price. Selections
 * are the exception: a backtest range has to cover real bars, so it is still
 * clamped to them.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { nearestBarTime, snapWithinBars } from '@/lib/chart'
import type { ChartHandle } from '@/components/chart/useChartInstance'
import type { Candle, SelectionRange } from '@/types/market'
import type { Drawing, DrawingDraft, DrawingPoint, ToolMode } from '@/types/drawing'
import type { FairValueGap, IctAnalysis, IctSettings, SwingPoint } from '@/types/ict'

/** Pointer distance, in pixels, within which a drag snaps to a swing point. */
const SNAP_RADIUS = 14

/** Minimum drag distance before a gesture counts as a shape, not a stray click. */
const MIN_DRAG_PX = 4

interface Props {
  symbol: string
  handle: ChartHandle
  candles: Candle[]
  ict?: IctAnalysis
  ictSettings: IctSettings
  drawings: Drawing[]
  selection: SelectionRange | null
  tool: ToolMode
  drawingColor: string
  selectedDrawingId: string | null
  snapToSwings: boolean
  /** Only the primary chart defines the backtest selection. */
  allowSelection: boolean
  onCreateDrawing: (drawing: DrawingDraft) => void
  onSelectionChange: (selection: SelectionRange | null) => void
  onGestureComplete: () => void
}

interface PendingGesture {
  start: DrawingPoint
  current: DrawingPoint
  startX: number
  startY: number
  currentX: number
  currentY: number
  moved: boolean
}

export function ChartOverlay({
  symbol,
  handle,
  candles,
  ict,
  ictSettings,
  drawings,
  selection,
  tool,
  drawingColor,
  selectedDrawingId,
  snapToSwings,
  allowSelection,
  onCreateDrawing,
  onSelectionChange,
  onGestureComplete,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [pending, setPending] = useState<PendingGesture | null>(null)
  const pendingRef = useRef<PendingGesture | null>(null)
  pendingRef.current = pending

  const interactive = tool !== 'cursor' && (tool !== 'select' || allowSelection)

  /**
   * Market time -> x for objects that always sit on a bar (ICT detections,
   * selections). Snapping keeps them aligned across interval changes.
   */
  const xOf = useCallback(
    (ms: number): number | null => {
      const snapped = nearestBarTime(candles, ms)
      return handle.timeToX(snapped ?? ms)
    },
    [candles, handle],
  )

  /**
   * Market time -> x for user drawings, which may legitimately sit off the
   * ends of the data. Falls back to the logical scale out there.
   */
  const xOfDrawing = useCallback(
    (ms: number): number | null => handle.timeToXFree(ms),
    [handle],
  )

  // ---- rendering -------------------------------------------------------
  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return

    const ratio = window.devicePixelRatio || 1
    const width = parent.clientWidth
    const height = parent.clientHeight
    if (width === 0 || height === 0) return

    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio
      canvas.height = height * ratio
      canvas.style.width = `${width}px`
      canvas.style.height = `${height}px`
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const palette = handle.palette()
    const yOf = handle.priceToY

    if (ict && ictSettings.showGaps) {
      for (const gap of ict.fair_value_gaps) {
        paintGap(ctx, gap, xOf, yOf, width, palette.bull, palette.bear)
      }
    }

    if (selection) {
      paintSelection(ctx, selection, xOf, height, palette.accent)
    }

    if (ict && ictSettings.showSmt) {
      for (const divergence of ict.smt_divergences) {
        paintSmt(ctx, divergence, xOf, yOf, palette.bull, palette.bear)
      }
    }

    if (ict && ictSettings.showSwings) {
      for (const point of ict.swing_points) {
        paintSwing(ctx, point, xOf, yOf, palette.muted)
      }
    }

    for (const drawing of drawings) {
      paintDrawing(ctx, drawing, xOfDrawing, yOf, width, drawing.id === selectedDrawingId)
    }

    const gesture = pendingRef.current
    if (gesture) {
      paintPending(ctx, gesture, tool, width, height, drawingColor, palette.accent)
    }
  }, [
    drawingColor,
    drawings,
    handle,
    ict,
    ictSettings.showGaps,
    ictSettings.showSmt,
    ictSettings.showSwings,
    selectedDrawingId,
    selection,
    tool,
    xOf,
    xOfDrawing,
  ])

  // Redraw on pan, zoom and resize -- the chart notifies us imperatively so
  // that scrolling does not re-render the React tree.
  useEffect(() => handle.subscribe(draw), [handle, draw])
  useEffect(() => {
    draw()
  }, [draw, pending])

  // ---- pointer handling ------------------------------------------------
  const pointFromEvent = useCallback(
    (event: React.PointerEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect()
      const x = event.clientX - rect.left
      const y = event.clientY - rect.top

      // `xToTime` is null everywhere past the last bar, which used to abort
      // the gesture before it started. The free conversion stays defined.
      const rawTime = handle.xToTimeFree(x)
      const rawPrice = handle.yToPrice(y)
      if (rawTime == null || rawPrice == null) return null

      // Snap only where there is a bar to snap to; keep the free timestamp
      // outside the data so the point stays under the cursor.
      let time = snapWithinBars(candles, rawTime) ?? rawTime
      let price = rawPrice

      // Snapping to a swing point is what makes "connect these two highs"
      // land exactly on the highs instead of near them.
      if (snapToSwings && ict?.swing_points.length && tool !== 'select') {
        const snapped = findSnapTarget(ict.swing_points, x, y, xOf, handle.priceToY)
        if (snapped) {
          time = snapped.time
          price = snapped.price
        }
      }

      return { point: { time, price }, x, y }
    },
    [candles, handle, ict, snapToSwings, tool, xOf],
  )

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!interactive || event.button !== 0) return
    const resolved = pointFromEvent(event)
    if (!resolved) return

    event.currentTarget.setPointerCapture(event.pointerId)

    if (tool === 'horizontal') {
      onCreateDrawing({ kind: 'horizontal', symbol, color: drawingColor, price: resolved.point.price })
      onGestureComplete()
      return
    }

    setPending({
      start: resolved.point,
      current: resolved.point,
      startX: resolved.x,
      startY: resolved.y,
      currentX: resolved.x,
      currentY: resolved.y,
      moved: false,
    })
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!pendingRef.current) return
    const resolved = pointFromEvent(event)
    if (!resolved) return

    setPending((previous) => {
      if (!previous) return previous
      const movedFar =
        Math.abs(resolved.x - previous.startX) > MIN_DRAG_PX ||
        Math.abs(resolved.y - previous.startY) > MIN_DRAG_PX
      return {
        ...previous,
        current: resolved.point,
        currentX: resolved.x,
        currentY: resolved.y,
        moved: previous.moved || movedFar,
      }
    })
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = pendingRef.current
    setPending(null)
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!gesture) return

    // A click without a drag is almost always a misfire, not a zero-width
    // shape, so it is discarded rather than committed.
    if (!gesture.moved) {
      onGestureComplete()
      return
    }

    if (tool === 'select') {
      // A backtest window has to be made of real bars, so a drag that runs off
      // the end of the data is pulled back to the edge candle rather than
      // selecting empty space. Drawings keep their free coordinates; this does
      // not.
      const start = nearestBarTime(
        candles,
        Math.min(gesture.start.time, gesture.current.time),
      )
      const end = nearestBarTime(
        candles,
        Math.max(gesture.start.time, gesture.current.time),
      )
      if (start != null && end != null && start !== end) {
        onSelectionChange({
          symbol,
          start_time: start,
          end_time: end,
          source_interval: (ict?.interval ?? '1h') as SelectionRange['source_interval'],
        })
      }
    } else if (tool === 'trendline' || tool === 'rectangle') {
      onCreateDrawing({
        kind: tool,
        symbol,
        color: drawingColor,
        from: gesture.start,
        to: gesture.current,
      })
    }

    onGestureComplete()
  }

  return (
    <canvas
      ref={canvasRef}
      className="absolute inset-0 z-10"
      style={{
        pointerEvents: interactive ? 'auto' : 'none',
        cursor: interactive ? 'crosshair' : 'default',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    />
  )
}

// --------------------------------------------------------------------------
// Painters
// --------------------------------------------------------------------------
type XConverter = (ms: number) => number | null
type YConverter = (price: number) => number | null

function paintGap(
  ctx: CanvasRenderingContext2D,
  gap: FairValueGap,
  xOf: XConverter,
  yOf: YConverter,
  width: number,
  bull: string,
  bear: string,
) {
  const top = yOf(gap.top)
  const bottom = yOf(gap.bottom)
  if (top == null || bottom == null) return

  const left = xOf(gap.start_time)
  if (left == null) return
  // An unfilled gap is still live, so its zone runs to the right edge.
  const right = gap.filled ? (xOf(gap.end_time) ?? width) : width

  const colour = gap.direction === 'bullish' ? bull : bear
  const height = Math.max(1, bottom - top)

  ctx.save()
  // Mitigated gaps fade: they have already done their job.
  ctx.globalAlpha = gap.filled ? 0.07 : gap.mitigated ? 0.12 : 0.2
  ctx.fillStyle = colour
  ctx.fillRect(left, top, Math.max(1, right - left), height)

  ctx.globalAlpha = gap.filled ? 0.2 : 0.5
  ctx.strokeStyle = colour
  ctx.lineWidth = 1
  ctx.setLineDash(gap.filled ? [3, 3] : [])
  ctx.strokeRect(left + 0.5, top + 0.5, Math.max(1, right - left) - 1, height - 1)
  ctx.restore()
}

function paintSelection(
  ctx: CanvasRenderingContext2D,
  selection: SelectionRange,
  xOf: XConverter,
  height: number,
  accent: string,
) {
  const left = xOf(selection.start_time)
  const right = xOf(selection.end_time)
  if (left == null || right == null) return

  const x = Math.min(left, right)
  const span = Math.max(2, Math.abs(right - left))

  ctx.save()
  ctx.globalAlpha = 0.14
  ctx.fillStyle = accent
  ctx.fillRect(x, 0, span, height)

  ctx.globalAlpha = 0.9
  ctx.strokeStyle = accent
  ctx.lineWidth = 1.5
  ctx.beginPath()
  ctx.moveTo(x + 0.5, 0)
  ctx.lineTo(x + 0.5, height)
  ctx.moveTo(x + span - 0.5, 0)
  ctx.lineTo(x + span - 0.5, height)
  ctx.stroke()
  ctx.restore()
}

function paintSmt(
  ctx: CanvasRenderingContext2D,
  divergence: IctAnalysis['smt_divergences'][number],
  xOf: XConverter,
  yOf: YConverter,
  bull: string,
  bear: string,
) {
  const x1 = xOf(divergence.start_time)
  const x2 = xOf(divergence.end_time)
  const y1 = yOf(divergence.primary_start_price)
  const y2 = yOf(divergence.primary_end_price)
  if (x1 == null || x2 == null || y1 == null || y2 == null) return

  const colour = divergence.bias === 'bullish' ? bull : bear

  ctx.save()
  ctx.strokeStyle = colour
  ctx.lineWidth = divergence.validity === 'swing_pair' ? 1.8 : 1.2
  ctx.setLineDash(divergence.validity === 'swing_pair' ? [] : [5, 3])
  ctx.globalAlpha = divergence.valid ? 0.95 : 0.45
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()

  // Endpoint dots make it obvious which two candles are being compared.
  ctx.setLineDash([])
  ctx.fillStyle = colour
  for (const [x, y] of [
    [x1, y1],
    [x2, y2],
  ]) {
    ctx.beginPath()
    ctx.arc(x, y, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  const label = divergence.inside_fair_value_gap ? 'SMT+FVG' : 'SMT'
  ctx.font = '9px ui-monospace, monospace'
  ctx.textBaseline = 'middle'
  const offset = divergence.kind === 'high' ? -9 : 11
  ctx.fillText(label, x2 + 5, y2 + offset)
  ctx.restore()
}

function paintSwing(
  ctx: CanvasRenderingContext2D,
  point: SwingPoint,
  xOf: XConverter,
  yOf: YConverter,
  colour: string,
) {
  const x = xOf(point.time)
  const y = yOf(point.price)
  if (x == null || y == null) return

  const up = point.kind === 'high'
  const tip = up ? y - 6 : y + 6

  ctx.save()
  ctx.globalAlpha = 0.75
  ctx.fillStyle = colour
  ctx.beginPath()
  ctx.moveTo(x, tip)
  ctx.lineTo(x - 3.5, up ? tip - 5 : tip + 5)
  ctx.lineTo(x + 3.5, up ? tip - 5 : tip + 5)
  ctx.closePath()
  ctx.fill()
  ctx.restore()
}

function paintDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  xOf: XConverter,
  yOf: YConverter,
  width: number,
  selected: boolean,
) {
  ctx.save()
  ctx.strokeStyle = drawing.color
  ctx.fillStyle = drawing.color
  ctx.lineWidth = selected ? 2.5 : 1.6
  ctx.setLineDash([])

  if (drawing.kind === 'horizontal') {
    const y = yOf(drawing.price)
    if (y != null) {
      ctx.beginPath()
      ctx.moveTo(0, y + 0.5)
      ctx.lineTo(width, y + 0.5)
      ctx.stroke()

      ctx.globalAlpha = 0.85
      ctx.font = '9px ui-monospace, monospace'
      ctx.textBaseline = 'bottom'
      ctx.fillText(drawing.price.toFixed(2), 4, y - 2)
    }
  } else {
    const x1 = xOf(drawing.from.time)
    const x2 = xOf(drawing.to.time)
    const y1 = yOf(drawing.from.price)
    const y2 = yOf(drawing.to.price)
    if (x1 != null && x2 != null && y1 != null && y2 != null) {
      if (drawing.kind === 'trendline') {
        ctx.beginPath()
        ctx.moveTo(x1, y1)
        ctx.lineTo(x2, y2)
        ctx.stroke()
        if (selected) {
          for (const [x, y] of [
            [x1, y1],
            [x2, y2],
          ]) {
            ctx.beginPath()
            ctx.arc(x, y, 3.5, 0, Math.PI * 2)
            ctx.fill()
          }
        }
      } else {
        const left = Math.min(x1, x2)
        const top = Math.min(y1, y2)
        const boxWidth = Math.abs(x2 - x1)
        const boxHeight = Math.abs(y2 - y1)
        ctx.globalAlpha = 0.14
        ctx.fillRect(left, top, boxWidth, boxHeight)
        ctx.globalAlpha = 1
        ctx.strokeRect(left + 0.5, top + 0.5, boxWidth, boxHeight)
      }
    }
  }
  ctx.restore()
}

function paintPending(
  ctx: CanvasRenderingContext2D,
  gesture: PendingGesture,
  tool: ToolMode,
  width: number,
  height: number,
  colour: string,
  accent: string,
) {
  ctx.save()
  ctx.setLineDash([4, 3])
  ctx.lineWidth = 1.5

  if (tool === 'select') {
    const left = Math.min(gesture.startX, gesture.currentX)
    const span = Math.abs(gesture.currentX - gesture.startX)
    ctx.fillStyle = accent
    ctx.globalAlpha = 0.16
    ctx.fillRect(left, 0, span, height)
    ctx.globalAlpha = 1
    ctx.strokeStyle = accent
    ctx.strokeRect(left + 0.5, 0.5, span, height - 1)
  } else if (tool === 'trendline') {
    ctx.strokeStyle = colour
    ctx.beginPath()
    ctx.moveTo(gesture.startX, gesture.startY)
    ctx.lineTo(gesture.currentX, gesture.currentY)
    ctx.stroke()
  } else if (tool === 'rectangle') {
    const left = Math.min(gesture.startX, gesture.currentX)
    const top = Math.min(gesture.startY, gesture.currentY)
    ctx.strokeStyle = colour
    ctx.fillStyle = colour
    ctx.globalAlpha = 0.12
    ctx.fillRect(left, top, Math.abs(gesture.currentX - gesture.startX), Math.abs(gesture.currentY - gesture.startY))
    ctx.globalAlpha = 1
    ctx.strokeRect(
      left + 0.5,
      top + 0.5,
      Math.abs(gesture.currentX - gesture.startX),
      Math.abs(gesture.currentY - gesture.startY),
    )
  }

  ctx.restore()
  void width
}

// --------------------------------------------------------------------------
function findSnapTarget(
  points: SwingPoint[],
  x: number,
  y: number,
  xOf: XConverter,
  yOf: YConverter,
): SwingPoint | null {
  let best: SwingPoint | null = null
  let bestDistance = SNAP_RADIUS

  for (const point of points) {
    const px = xOf(point.time)
    const py = yOf(point.price)
    if (px == null || py == null) continue
    const distance = Math.hypot(px - x, py - y)
    if (distance < bestDistance) {
      bestDistance = distance
      best = point
    }
  }

  return best
}
