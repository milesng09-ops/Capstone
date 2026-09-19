/**
 * Everything drawn on top of the candles.
 *
 * Lightweight Charts has no drawing tools and no way to render arbitrary
 * shapes, so this is a plain `<canvas>` stretched over the chart that converts
 * market coordinates to pixels itself. It renders, back to front:
 *
 *   1. fair value gap zones
 *   2. the evidence behind the selected trade
 *   3. the veil over history the backtest is not allowed to search
 *   4. the backtest selection band
 *   5. SMT divergence lines
 *   6. swing point markers
 *   7. simulated trades, as long/short position boxes
 *   8. user drawings (trend lines, levels, zones)
 *   9. the shape currently being dragged
 *
 * **Almost none of that is on by default.** Drawn all at once, the detectors
 * cover an index future end to end -- a gap or a pivot on nearly every bar --
 * and the chart stops being readable exactly where it matters. So the
 * overlays start off, the detectors keep running for the search, and what
 * gets painted is what was asked for: the trades a run produced, and the
 * evidence behind whichever one is selected.
 *
 * **Pointer ownership.** Two input models want the same mouse: the chart pans
 * and zooms with it, and the overlay draws with it. They are separated by
 * making the canvas `pointer-events: none` by default, so the chart is in
 * charge, and handing it the pointer only for as long as the overlay has
 * something to do with it -- while a drawing tool is held, or while the
 * cursor is actually over a drawing. Hover is tracked by listening on the
 * *parent* element, which still receives the move events that pass straight
 * through the transparent canvas.
 *
 * That is what makes a drawing directly editable without the chart seizing up
 * around it: click one to select, drag its body to move it, drag a corner to
 * reshape it, and everywhere else the chart pans exactly as before.
 *
 * **One edit, one undo step.** A drag previews locally and writes to the
 * store once, on release. Dragging a line across the pane is therefore a
 * single Ctrl+Z, not a hundred.
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  magnetPrice,
  medianBarSpacingMs,
  nearestBarTime,
  snapWithinBars,
} from '@/lib/chart'
import {
  handlePositions,
  hitKey,
  hitTestChips,
  hitTestDrawings,
  isProjectedPosition,
  rangeChip,
  CHIP_HEIGHT_PX,
  type RangeChip,
  projectDrawing,
  resizeDrawing,
  translateDrawing,
  type DrawingHit,
  type ProjectedDrawing,
  type ProjectedPlannedTrade,
  type ProjectedSegment,
} from '@/lib/drawings'
import {
  hitTestPositions,
  positionBox,
  type PositionBox,
  type ProjectedPosition,
  type TradeEvidence,
} from '@/lib/trades'
import type { ChartHandle } from '@/components/chart/useChartInstance'
import type { Trade } from '@/types/backtest'
import { INTERVAL_MS } from '@/types/market'
import type { Candle, Interval, SelectionRange, TimeWindow } from '@/types/market'
import {
  BRUSH_MIN_STEP_PX,
  DEFAULT_NOTE,
  DEFAULT_POSITION_R,
  fibLevels,
  hasTwoPoints,
  isDragTool,
  isPathTool,
  isPointTool,
  isRangeTool,
  positionFromDrag,
  TEXT_CHAR_PX,
  TEXT_LINE_PX,
  type FibDrawing,
  type PositionDrawing,
} from '@/types/drawing'
import type { Drawing, DrawingDraft, DrawingPoint, ToolMode } from '@/types/drawing'
import type {
  FairValueGap,
  IctAnalysis,
  IctSettings,
  LiquidityPool,
  SwingPoint,
} from '@/types/ict'
import type { ChartPalette } from '@/lib/chart'

/** Pointer distance, in pixels, within which a drag snaps to a swing point. */
const SNAP_RADIUS = 14

/** Minimum drag distance before a gesture counts as a shape, not a stray click. */
const MIN_DRAG_PX = 4

/**
 * Does a shape between these two points actually cover anything?
 *
 * Asked in **market** coordinates rather than pixels, because the answer must
 * not depend on how far the chart happens to be zoomed: a zone that is valid
 * at one zoom and refused at another is a tool that behaves differently on
 * Tuesday. A pixel test also has to pick a threshold, and any threshold
 * refuses shapes somebody legitimately wanted -- a thin price band is a real
 * annotation, not a mistake.
 *
 * So the only thing rejected is genuine degeneracy. A line needs to move in
 * some direction; a zone needs to span both a stretch of time and a range of
 * price, because collapsed on either side it has no area at all. That is the
 * shape that painted nothing while staying selectable -- the bug this guards.
 * The pixel-level "was this a drag or a stray click" question is separate,
 * and `gesture.moved` already answers it.
 */
function isVisiblySized(
  kind: 'trendline' | 'rectangle' | 'ray' | 'arrow' | 'fib',
  from: DrawingPoint,
  to: DrawingPoint,
): boolean {
  const spansTime = from.time !== to.time
  const spansPrice = from.price !== to.price
  // A zone needs extent on both axes or it is a line pretending to be a box.
  // A retracement needs price above all: every level collapses onto one line
  // when the two swings are at the same price, which is a tool that paints
  // seven lines on top of each other and measures nothing.
  if (kind === 'rectangle') return spansTime && spansPrice
  if (kind === 'fib') return spansPrice
  // The line-like shapes need only one: a perfectly flat trend line is a
  // legitimate thing to draw, and a ray needs a direction, which either axis
  // can supply.
  return spansTime || spansPrice
}

/** Narrowest a position box may be drawn, so a one-bar trade is still visible. */
const MIN_POSITION_WIDTH_PX = 5

/** Smallest a user-drawn shape is ever painted, so none is invisible. */
const MIN_SHAPE_PX = 2

interface Props {
  symbol: string
  handle: ChartHandle
  candles: Candle[]
  /** The interval on screen. A selection is defined in terms of these bars. */
  interval: Interval
  ict?: IctAnalysis
  ictSettings: IctSettings
  drawings: Drawing[]
  selection: SelectionRange | null
  /** History the backtest may search. Outside it the candles are veiled. */
  testWindow: TimeWindow | null
  /** Simulated trades taken on *this* instrument. */
  trades: Trade[]
  selectedTradeId: string | null
  /** Detections behind the selected trade, or null when none is selected. */
  evidence: TradeEvidence | null
  tool: ToolMode
  drawingColor: string
  drawingWidth: number
  selectedDrawingId: string | null
  snapToSwings: boolean
  magnet: boolean
  /** Only the primary chart defines the backtest selection. */
  allowSelection: boolean
  onCreateDrawing: (drawing: DrawingDraft) => void
  onUpdateDrawing: (id: string, drawing: Drawing) => void
  onSelectDrawing: (id: string | null) => void
  onSelectionChange: (selection: SelectionRange | null) => void
  onTestWindowChange: (window: TimeWindow | null) => void
  onSelectTrade: (id: string | null) => void
  /**
   * A gesture ended. `committed` is false when nothing was placed -- a
   * misfire, an Escape, or a drag that collapsed onto a single bar -- so the
   * caller can keep the tool held rather than making the user pick it again
   * for a shape they never got.
   */
  onGestureComplete: (committed: boolean) => void
}

/** A shape being drawn for the first time. */
interface PendingGesture {
  start: DrawingPoint
  current: DrawingPoint
  startX: number
  startY: number
  currentX: number
  currentY: number
  moved: boolean
  /**
   * The first point is placed and the pointer is free.
   *
   * Two-point shapes can be drawn either way: press-drag-release, or click
   * once to drop the first point, move, and click again. The second is what
   * every charting platform does and is markedly easier over a long
   * distance, since it does not ask the hand to hold a button steady across
   * half the screen. Supporting both costs one flag and takes nothing away.
   */
  armed: boolean
  /**
   * The pointer's path, for the tools that are the path rather than its ends.
   *
   * Thinned as it is collected: a pointer stream is hundreds of samples a
   * second, and a stroke that kept them all would be a drawing in
   * `localStorage` larger than the rest of the workspace. Only the brush
   * fills this in; for every other tool it stays empty.
   */
  path: DrawingPoint[]
  /** Screen position of the last recorded path point, for the thinning test. */
  pathX: number
  pathY: number
}

/** An existing shape being moved or reshaped. */
interface ActiveDrag {
  hit: DrawingHit
  /** The drawing as it was when grabbed; every frame transforms from this. */
  original: Drawing
  /** What to paint until the drag is committed. */
  preview: Drawing
  /** Unsnapped market point under the pointer at the moment of the grab. */
  origin: DrawingPoint
  startX: number
  startY: number
  moved: boolean
}

export function ChartOverlay({
  symbol,
  handle,
  candles,
  interval,
  ict,
  ictSettings,
  drawings,
  selection,
  testWindow,
  trades,
  selectedTradeId,
  evidence,
  tool,
  drawingColor,
  drawingWidth,
  selectedDrawingId,
  snapToSwings,
  magnet,
  allowSelection,
  onCreateDrawing,
  onUpdateDrawing,
  onSelectDrawing,
  onSelectionChange,
  onTestWindowChange,
  onSelectTrade,
  onGestureComplete,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  // Each gesture is mirrored into a ref so that the imperative redraw -- which
  // the chart triggers on every pan and zoom -- never paints a stale frame,
  // and so that cancelling can take effect before React has re-rendered.
  const [pending, setPending] = useState<PendingGesture | null>(null)
  const pendingRef = useRef<PendingGesture | null>(null)
  const [drag, setDrag] = useState<ActiveDrag | null>(null)
  const dragRef = useRef<ActiveDrag | null>(null)
  const [hover, setHover] = useState<DrawingHit | null>(null)
  const hoverRef = useRef<DrawingHit | null>(null)
  /** Set while a drawing is being dragged; see `suppress` below. */
  const suppressRef = useRef(false)
  /**
   * A press on the chart that has not yet become anything.
   *
   * Clicking a trade selects it, but the same press is also how the chart is
   * panned, so the two cannot be told apart until the pointer comes back up:
   * travelled, and it was a pan; still, and it was a click.
   */
  const pressRef = useRef<{ x: number; y: number; tradeId: string | null } | null>(null)

  /**
   * One repaint per animation frame, however many events asked for it.
   *
   * The chart notifies on every step of a pan and a price-scale drag, and a
   * gesture adds a move event of its own on top. Painting synchronously for
   * each of those did the same work several times inside one frame, none of
   * which the screen ever showed -- which is what "it takes a minute to be
   * there" looks like from the outside.
   */
  const drawRef = useRef<() => void>(() => {})
  const frameRef = useRef(0)
  const scheduleDraw = useCallback(() => {
    if (frameRef.current) return
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = 0
      drawRef.current()
    })
  }, [])

  useEffect(
    () => () => {
      if (frameRef.current) window.cancelAnimationFrame(frameRef.current)
    },
    [],
  )

  /**
   * The ref is the truth; the state only records whether a gesture is running.
   *
   * `draw` reads the refs, so re-rendering React on every pointer move bought
   * nothing and cost a full render of the overlay per move. The state is still
   * needed -- the cursor and the Escape handler ask whether a gesture exists,
   * and `hit` is fixed for the life of one -- so it is written on the
   * transitions only, not on every frame of the movement between them.
   */
  const updatePending = useCallback(
    (value: PendingGesture | null) => {
      const wasRunning = pendingRef.current != null
      pendingRef.current = value
      if (wasRunning !== (value != null)) setPending(value)
      scheduleDraw()
    },
    [scheduleDraw],
  )

  const updateDrag = useCallback(
    (value: ActiveDrag | null) => {
      const wasRunning = dragRef.current != null
      dragRef.current = value
      if (wasRunning !== (value != null)) setDrag(value)
      scheduleDraw()
    },
    [scheduleDraw],
  )

  const updateHover = useCallback((value: DrawingHit | null) => {
    hoverRef.current = value
    setHover(value)
  }, [])

  /**
   * True while a tool is held, i.e. the next press starts a new shape. The
   * range tools are inert on a comparison chart -- a backtest runs on the
   * primary -- which leaves the pointer free to edit drawings there exactly
   * as the cursor tool would.
   */
  const drawingActive = isDragTool(tool) && (!isRangeTool(tool) || allowSelection)

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

  /** Trades as boxes, in market units. Projected to pixels at paint time. */
  const boxes = useMemo(() => trades.map(positionBox), [trades])

  // The last painted geometry, kept so a click can be tested against exactly
  // what is on screen rather than against a fresh projection that a pan in
  // flight may already have invalidated.
  const projectedRef = useRef<ProjectedPosition[]>([])

  /*
   * The dismiss tabs on the backtest ranges.
   *
   * Stacked at the pane's left rather than at each band's own edge: the two
   * commonly start within a few pixels of each other, and two tabs sharing a
   * corner are two targets you cannot tell apart. Fixed, they are always in
   * the same place and always separate.
   *
   * Computed here rather than inside `draw` because their position depends on
   * nothing the chart projects -- only on which ranges exist. That keeps what
   * is clickable defined even in a frame that painted nothing.
   */
  const rangeChips = useMemo<RangeChip[]>(() => {
    if (!allowSelection) return []
    const chips: RangeChip[] = []
    if (selection) chips.push(rangeChip('selection', 'setup', 6, 6))
    if (testWindow) {
      chips.push(rangeChip('window', 'test window', 6, 6 + CHIP_HEIGHT_PX + 4))
    }
    return chips
  }, [allowSelection, selection, testWindow])

  const chipsRef = useRef<RangeChip[]>(rangeChips)
  chipsRef.current = rangeChips

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

    // The backing store only. The element's size on screen is set in CSS
    // above; writing it here as well made painting the thing that decided how
    // big it was, which is how it came to be 300x150 whenever the first frame
    // never arrived.
    if (canvas.width !== width * ratio || canvas.height !== height * ratio) {
      canvas.width = width * ratio
      canvas.height = height * ratio
    }

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, width, height)

    const palette = handle.palette()
    const yOf = handle.priceToY

    /*
     * What the pane can actually show, as a pair of timestamps.
     *
     * The detectors run over the whole loaded history, and on a 180-day
     * hourly ES chart that is six hundred fair value gaps. Painting all of
     * them every frame meant six hundred binary searches through the candles
     * and six hundred sets of canvas calls, almost all of it landing far
     * outside the pane. Two conversions here turn that into one integer
     * comparison apiece.
     */
    const viewFrom = handle.xToTimeFree(0)
    const viewTo = handle.xToTimeFree(width)
    const onScreen = (start: number, end: number) =>
      viewFrom == null || viewTo == null || (end >= viewFrom && start <= viewTo)

    if (ict && ictSettings.showGaps) {
      for (const gap of ict.fair_value_gaps) {
        if (!onScreen(gap.start_time, gap.end_time)) continue
        paintGap(ctx, gap, xOf, yOf, width, palette.bull, palette.bear)
      }
    }

    // The detections behind one trade, drawn whether or not the overlay for
    // that class is on -- that is the whole point of asking for them. What is
    // already on screen is not painted twice.
    if (evidence) {
      paintEvidenceWindow(ctx, evidence.window, xOf, height, palette)
      if (!ictSettings.showGaps) {
        for (const gap of evidence.gaps) {
          if (!onScreen(gap.start_time, gap.end_time)) continue
          paintGap(ctx, gap, xOf, yOf, width, palette.bull, palette.bear)
        }
      }
    }

    // Veiled last among the background layers, so it dims the detections too:
    // everything under it is out of scope, not just the candles.
    if (testWindow) {
      paintTestWindow(ctx, testWindow, xOf, width, height, palette)
    }

    if (selection) {
      paintSelection(ctx, selection, xOf, height, palette.accent)
    }

    for (const chip of rangeChips) {
      paintRangeChip(
        ctx,
        chip,
        palette,
        chip.kind === 'selection' ? palette.accent : palette.muted,
      )
    }

    // Shelves sit above the zones and below the markers: they are levels, so
    // they read as part of the background a trade is judged against rather
    // than as an annotation on top of it.
    if (ict && ictSettings.showLiquidity) {
      for (const pool of ict.liquidity_pools) {
        // A standing shelf runs to the right edge, so it is on screen
        // whenever its first pivot is behind the right edge of the pane.
        const end = pool.swept ? (pool.swept_time ?? pool.end_time) : Number.MAX_SAFE_INTEGER
        if (!onScreen(pool.start_time, end)) continue
        paintLiquidityPool(ctx, pool, xOf, yOf, width, palette)
      }
    }

    if (ict && ictSettings.showSmt) {
      for (const divergence of ict.smt_divergences) {
        if (!onScreen(divergence.start_time, divergence.end_time)) continue
        paintSmt(ctx, divergence, xOf, yOf, palette.bull, palette.bear)
      }
    }

    if (ict && ictSettings.showSwings) {
      for (const point of ict.swing_points) {
        if (!onScreen(point.time, point.time)) continue
        paintSwing(ctx, point, xOf, yOf, palette.muted)
      }
    }

    if (evidence) {
      if (!ictSettings.showSmt) {
        for (const divergence of evidence.divergences) {
          if (!onScreen(divergence.start_time, divergence.end_time)) continue
          paintSmt(ctx, divergence, xOf, yOf, palette.bull, palette.bear)
        }
      }
      if (!ictSettings.showSwings) {
        for (const point of evidence.swings) {
          if (!onScreen(point.time, point.time)) continue
          paintSwing(ctx, point, xOf, yOf, palette.muted)
        }
      }
      // The shelf a liquidity trade was taken against, and the one it aimed
      // at. Without these, selecting a trade from the sweep preset showed
      // every other detector's working and not the one that decided it.
      if (!ictSettings.showLiquidity) {
        for (const pool of evidence.pools) {
          const end = pool.swept
            ? (pool.swept_time ?? pool.end_time)
            : Number.MAX_SAFE_INTEGER
          if (!onScreen(pool.start_time, end)) continue
          paintLiquidityPool(ctx, pool, xOf, yOf, width, palette)
        }
      }
    }

    // Trades, as the long/short position tool a chart is normally marked up
    // with: entry in the middle, risk one side, reward the other, running the
    // length of the hold.
    const projected: ProjectedPosition[] = []
    for (const box of boxes) {
      const item = paintPosition(ctx, box, xOfDrawing, yOf, palette, {
        selected: box.id === selectedTradeId,
        // With one trade picked, the rest step back rather than disappear:
        // where this trade sits among the others is part of reading it.
        dimmed: selectedTradeId != null && box.id !== selectedTradeId,
      })
      if (item) projected.push(item)
    }
    projectedRef.current = projected

    // An in-flight drag is painted in place of the stored shape, so the store
    // is written once on release rather than on every frame.
    const preview = dragRef.current?.preview ?? null
    const hoveredId = hoverRef.current?.id ?? null
    let offData = 0
    for (const drawing of drawings) {
      const shown = preview && preview.id === drawing.id ? preview : drawing
      const painted = paintDrawing(ctx, shown, xOfDrawing, yOf, width, height, {
        selected: shown.id === selectedDrawingId,
        hovered: shown.id === hoveredId,
        background: palette.background,
        palette,
      })
      if (!painted) offData += 1
    }

    // A drawing that cannot be placed is not painted, and until now that was
    // the whole story: it simply was not there, with nothing to say whether it
    // had been deleted, had moved, or was sitting outside the candles this
    // interval loaded. "I don't know if the line disappeared or what's going
    // on" is a fair reading of silence. Say it instead.
    if (offData > 0) {
      paintOffDataNote(ctx, offData, height, palette)
    }

    const gesture = pendingRef.current
    if (gesture) {
      paintPending(ctx, gesture, tool, width, height, drawingColor, palette.accent)
    }
  }, [
    boxes,
    drawingColor,
    drawings,
    evidence,
    handle,
    ict,
    ictSettings.showGaps,
    ictSettings.showLiquidity,
    ictSettings.showSmt,
    ictSettings.showSwings,
    selectedDrawingId,
    selectedTradeId,
    rangeChips,
    selection,
    testWindow,
    tool,
    xOf,
    xOfDrawing,
  ])

  // Redraw on pan, zoom and resize -- the chart notifies us imperatively so
  // that scrolling does not re-render the React tree, and the frame scheduler
  // collapses a burst of notifications into the one paint the screen can use.
  drawRef.current = draw
  useEffect(() => handle.subscribe(scheduleDraw), [handle, scheduleDraw])
  useEffect(() => {
    scheduleDraw()
  }, [draw, hover, scheduleDraw])

  // ---- hit-testing -----------------------------------------------------
  const hitTestAt = useCallback(
    (x: number, y: number): DrawingHit | null => {
      if (drawings.length === 0) return null
      const projected: ProjectedDrawing[] = []
      for (const drawing of drawings) {
        const item = projectDrawing(drawing, xOfDrawing, handle.priceToY)
        if (item) projected.push(item)
      }
      return hitTestDrawings(projected, x, y, selectedDrawingId)
    },
    [drawings, handle, selectedDrawingId, xOfDrawing],
  )

  // ---- pointer handling ------------------------------------------------
  const pointAt = useCallback(
    (clientX: number, clientY: number, useSwingSnap: boolean) => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const x = clientX - rect.left
      const y = clientY - rect.top

      // `xToTime` is null everywhere past the last bar, which used to abort
      // the gesture before it started. The free conversion stays defined.
      const rawTime = handle.xToTimeFree(x)
      const rawPrice = handle.yToPrice(y)
      if (rawTime == null || rawPrice == null) return null

      // Snap only where there is a bar to snap to; keep the free timestamp
      // outside the data so the point stays under the cursor.
      let time = snapWithinBars(candles, rawTime) ?? rawTime
      let price = rawPrice

      // The magnet: pull the price onto the nearest of the bar's own four
      // levels. Applied before the swing snap, which is the stronger claim --
      // a swing point is a specific bar *and* a specific price, so when one is
      // in range it should win outright rather than be nudged off its level.
      if (magnet) {
        const level = magnetPrice(candles, time, price)
        if (level != null) price = level
      }

      // Snapping to a swing point is what makes "connect these two highs"
      // land exactly on the highs instead of near them.
      // Only snap to markers the chart is actually showing. Detectors run on
      // every bar whether or not their overlay is on, so with swings hidden
      // this pulled endpoints up to 14px towards targets the user could not
      // see -- indistinguishable from the tool being inaccurate.
      if (useSwingSnap && ictSettings.showSwings && ict?.swing_points.length) {
        const snapped = findSnapTarget(ict.swing_points, x, y, xOf, handle.priceToY)
        if (snapped) {
          time = snapped.time
          price = snapped.price
        }
      }

      return {
        point: { time, price },
        raw: { time: rawTime, price: rawPrice },
        x,
        y,
      }
    },
    [candles, handle, ict, ictSettings.showSwings, magnet, xOf],
  )

  /**
   * Editing existing drawings, driven from the parent element.
   *
   * The overlay canvas stays transparent to the pointer while no tool is
   * held, so the chart keeps its pan, zoom and wheel exactly as before. That
   * means the press has to be intercepted on the way *down* to the chart --
   * hence the capture phase, which runs on this element before the chart's
   * own listeners run on its children.
   *
   * The chart binds `mousedown` and `touchstart` rather than `pointerdown`,
   * so cancelling the pointer event is not enough on its own: those two are
   * suppressed separately for as long as a drag is in progress.
   */
  useEffect(() => {
    const canvas = canvasRef.current
    const parent = canvas?.parentElement
    if (!canvas || !parent) return

    if (drawingActive) {
      // A tool is held. The canvas owns the pointer and shows its own cursor,
      // and a hover highlight would only compete with the shape being drawn.
      updateHover(null)
      parent.style.cursor = ''
      return
    }

    const locate = (event: PointerEvent): DrawingHit | null => {
      const rect = canvas.getBoundingClientRect()
      return hitTestAt(event.clientX - rect.left, event.clientY - rect.top)
    }

    const offsetOf = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect()
      return { x: event.clientX - rect.left, y: event.clientY - rect.top }
    }

    const handleMove = (event: PointerEvent) => {
      if (dragRef.current) return
      const hit = locate(event)
      if (hitKey(hit) !== hitKey(hoverRef.current)) updateHover(hit)

      // A trade is clickable but not draggable, so it only wants a cursor.
      // Set here rather than through state: a hover that changes nothing
      // React renders should not cost a render.
      if (!hit) {
        const { x, y } = offsetOf(event)
        const clickable =
          hitTestChips(chipsRef.current, x, y) != null ||
          hitTestPositions(projectedRef.current, x, y) != null
        parent.style.cursor = clickable ? 'pointer' : ''
      }
    }

    const handleLeave = () => {
      if (dragRef.current || !hoverRef.current) return
      updateHover(null)
    }

    const handleDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      // The legend floats in this same element. Pressing a badge or the fit
      // button is not a press on the chart and should not disturb anything.
      if (event.target instanceof Element && event.target.closest('button, a, input')) {
        return
      }

      // A range tab is tested before anything else on the surface. It is
      // small, deliberately placed, and the only way to take a band off the
      // chart by pointer -- losing it to a drawing that happens to lie under
      // the corner would put the user straight back where they started.
      const rect = canvas.getBoundingClientRect()
      const chip = hitTestChips(
        chipsRef.current,
        event.clientX - rect.left,
        event.clientY - rect.top,
      )
      if (chip) {
        event.preventDefault()
        event.stopPropagation()
        if (chip.kind === 'selection') onSelectionChange(null)
        else onTestWindowChange(null)
        return
      }

      // Re-tested rather than read from the last hover, because a touch
      // arrives with no hover behind it.
      const hit = locate(event)
      onSelectDrawing(hit?.id ?? null)

      if (!hit) {
        // Nothing to grab. Remember where the press landed and what was under
        // it; `handleUp` decides whether that turns out to be a click.
        const { x, y } = offsetOf(event)
        pressRef.current = { x, y, tradeId: hitTestPositions(projectedRef.current, x, y) }
        return
      }
      pressRef.current = null

      const target = drawings.find((drawing) => drawing.id === hit.id)
      const resolved = pointAt(event.clientX, event.clientY, false)
      if (!target || !resolved) return

      event.preventDefault()
      suppressRef.current = true
      updateHover(hit)
      updateDrag({
        hit,
        original: target,
        preview: target,
        origin: resolved.raw,
        startX: resolved.x,
        startY: resolved.y,
        moved: false,
      })
    }

    /**
     * A press that never travelled is a click: it selects the trade under it,
     * or clears the selection when there was none. A press that panned the
     * chart selects nothing, which is what keeps the two gestures apart.
     */
    const handleUp = (event: PointerEvent) => {
      const press = pressRef.current
      pressRef.current = null
      if (!press) return

      const { x, y } = offsetOf(event)
      if (Math.abs(x - press.x) > MIN_DRAG_PX || Math.abs(y - press.y) > MIN_DRAG_PX) return
      onSelectTrade(press.tradeId)
    }

    const suppress = (event: Event) => {
      if (!suppressRef.current) return
      event.stopPropagation()
      event.preventDefault()
    }

    parent.addEventListener('pointermove', handleMove)
    parent.addEventListener('pointerleave', handleLeave)
    parent.addEventListener('pointerdown', handleDown, { capture: true })
    // At the window, so a press released off the pane still resolves rather
    // than leaving a stale candidate behind.
    window.addEventListener('pointerup', handleUp)
    parent.addEventListener('mousedown', suppress, { capture: true })
    parent.addEventListener('touchstart', suppress, { capture: true, passive: false })

    return () => {
      parent.removeEventListener('pointermove', handleMove)
      parent.removeEventListener('pointerleave', handleLeave)
      parent.removeEventListener('pointerdown', handleDown, { capture: true })
      window.removeEventListener('pointerup', handleUp)
      parent.removeEventListener('mousedown', suppress, { capture: true })
      parent.removeEventListener('touchstart', suppress, { capture: true })
      parent.style.cursor = ''
      pressRef.current = null
    }
  }, [
    drawingActive,
    drawings,
    hitTestAt,
    onSelectDrawing,
    onSelectTrade,
    onSelectionChange,
    onTestWindowChange,
    pointAt,
    updateDrag,
    updateHover,
  ])

  /**
   * A drag continues at the window, so it survives the pointer leaving the
   * pane and does not depend on any element having captured it. Registered
   * once and inert unless a drag is actually running.
   */
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = dragRef.current
      if (!active) return
      const resolved = pointAt(event.clientX, event.clientY, snapToSwings)
      if (!resolved) return

      // Moving the whole shape follows the raw pointer, so it does not jump
      // between bars under the hand. A grabbed endpoint snaps, because that
      // is the case where landing exactly on a high is the entire point.
      const preview =
        active.hit.part === 'body'
          ? translateDrawing(
              active.original,
              resolved.raw.time - active.origin.time,
              resolved.raw.price - active.origin.price,
            )
          : resizeDrawing(active.original, active.hit, resolved.point)

      updateDrag({
        ...active,
        preview,
        moved:
          active.moved ||
          Math.abs(resolved.x - active.startX) > MIN_DRAG_PX ||
          Math.abs(resolved.y - active.startY) > MIN_DRAG_PX,
      })
    }

    const finish = () => {
      const active = dragRef.current
      suppressRef.current = false
      if (!active) return
      updateDrag(null)
      // A press that never moved is a plain click. The shape is already
      // selected, and writing it back unchanged would spend an undo step on
      // nothing.
      if (!active.moved) return
      // Dragging a corner past its opposite collapses the shape exactly as a
      // degenerate first drag does, and with the same result: something
      // stored, selectable and invisible. Refuse the write and leave the
      // drawing as it was, which is still on screen to try again from.
      const shape = active.preview
      if (hasTwoPoints(shape) && !isVisiblySized(shape.kind, shape.from, shape.to)) {
        return
      }
      onUpdateDrawing(active.original.id, shape)
    }

    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', finish)
    window.addEventListener('pointercancel', finish)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', finish)
      window.removeEventListener('pointercancel', finish)
    }
  }, [onUpdateDrawing, pointAt, snapToSwings, updateDrag])

  /**
   * Cursor feedback lives on the parent rather than the canvas: the canvas is
   * transparent to the pointer here, and an element that cannot be hit cannot
   * set a cursor. The chart leaves its own price pane at `auto`, so this
   * cascades through cleanly.
   */
  useEffect(() => {
    const parent = canvasRef.current?.parentElement
    if (!parent || drawingActive) return
    parent.style.cursor = cursorFor(drag, hover)
  }, [drag, drawingActive, hover])

  const handlePointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || !drawingActive) return

    // A range is made of bars, not of shapes, so it never snaps to a swing
    // point -- that would move the window off the candles it names.
    const resolved = pointAt(event.clientX, event.clientY, !isRangeTool(tool) && snapToSwings)
    if (!resolved) return

    // Already armed: this press is the *second* click of a two-click
    // placement, so the gesture already holds the first point and must be
    // left alone for the release to commit it.
    if (pendingRef.current?.armed) return

    event.currentTarget.setPointerCapture(event.pointerId)
    updatePending({
      start: resolved.point,
      current: resolved.point,
      startX: resolved.x,
      startY: resolved.y,
      currentX: resolved.x,
      currentY: resolved.y,
      moved: false,
      armed: false,
      path: isPathTool(tool) ? [resolved.point] : [],
      pathX: resolved.x,
      pathY: resolved.y,
    })
  }

  const handlePointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const gesture = pendingRef.current
    if (!gesture) return
    const resolved = pointAt(event.clientX, event.clientY, !isRangeTool(tool) && snapToSwings)
    if (!resolved) return

    // The brush records where the pointer has been, not where it started.
    // Points closer together than a few pixels add nothing a reader can see
    // and cost storage on every one of them.
    const stepped =
      isPathTool(tool) &&
      Math.hypot(resolved.x - gesture.pathX, resolved.y - gesture.pathY) >=
        BRUSH_MIN_STEP_PX

    updatePending({
      ...gesture,
      current: resolved.point,
      currentX: resolved.x,
      currentY: resolved.y,
      moved:
        gesture.moved ||
        Math.abs(resolved.x - gesture.startX) > MIN_DRAG_PX ||
        Math.abs(resolved.y - gesture.startY) > MIN_DRAG_PX,
      path: stepped ? [...gesture.path, resolved.point] : gesture.path,
      pathX: stepped ? resolved.x : gesture.pathX,
      pathY: stepped ? resolved.y : gesture.pathY,
    })
  }

  const handlePointerCancel = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
    if (!pendingRef.current) return
    updatePending(null)
    onGestureComplete(false)
  }

  const handlePointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }

    const gesture = pendingRef.current
    if (!gesture) return

    // A click without a drag on a two-point shape arms it rather than
    // discarding it: the first point is placed and the next click finishes
    // the shape. A point tool is exempt -- it has one coordinate, so pressing
    // and releasing in place *is* the whole gesture -- and so are the range
    // tools, which name a span of bars and are only ever swept.
    if (
      !gesture.moved &&
      !gesture.armed &&
      !isPointTool(tool) &&
      !isRangeTool(tool) &&
      !isPathTool(tool)
    ) {
      updatePending({ ...gesture, armed: true })
      return
    }

    updatePending(null)

    if (tool === 'horizontal') {
      onCreateDrawing({
        kind: 'horizontal',
        symbol,
        color: drawingColor,
        width: drawingWidth,
        price: gesture.current.price,
      })
    } else if (tool === 'vertical') {
      onCreateDrawing({
        kind: 'vertical',
        symbol,
        color: drawingColor,
        width: drawingWidth,
        time: gesture.current.time,
      })
    } else if (tool === 'horizontal_ray') {
      onCreateDrawing({
        kind: 'horizontal_ray',
        symbol,
        color: drawingColor,
        width: drawingWidth,
        from: gesture.current,
      })
    } else if (tool === 'text') {
      onCreateDrawing({
        kind: 'text',
        symbol,
        color: drawingColor,
        width: drawingWidth,
        at: gesture.current,
        text: DEFAULT_NOTE,
      })
    } else if (isRangeTool(tool)) {
      // A range has to be made of real bars, so a drag that runs off the end
      // of the data is pulled back to the edge candle rather than covering
      // empty space. Drawings keep their free coordinates; these do not.
      const start = nearestBarTime(
        candles,
        Math.min(gesture.start.time, gesture.current.time),
      )
      const end = nearestBarTime(
        candles,
        Math.max(gesture.start.time, gesture.current.time),
      )
      // A range narrower than one bar names nothing, so it is dropped -- and
      // the tool stays held, because the user was mid-gesture rather than
      // finished.
      if (start == null || end == null || start === end) {
        onGestureComplete(false)
        return
      }
      if (tool === 'select') {
        onSelectionChange({
          symbol,
          start_time: start,
          end_time: end,
          source_interval: interval,
        })
      } else {
        onTestWindowChange({ start_time: start, end_time: end })
      }
    } else if (tool === 'brush') {
      // Two points is the least that can be a line. One is a press that never
      // moved, which is a mis-click rather than a stroke -- and the tool stays
      // held, so trying again costs nothing.
      if (gesture.path.length < 2) {
        onGestureComplete(false)
        return
      }
      onCreateDrawing({
        kind: 'brush',
        symbol,
        color: drawingColor,
        width: drawingWidth,
        points: gesture.path,
      })
      onGestureComplete(true)
      return
    } else if (tool === 'long' || tool === 'short') {
      // The drag is entry to stop, because risk is the number a trader
      // decides; the target follows from it as a multiple. A drag with no
      // height sets no risk, which would make the reward-to-risk undefined.
      if (gesture.start.price === gesture.current.price) {
        onGestureComplete(false)
        return
      }
      const { stop, target } = positionFromDrag(
        tool,
        gesture.start.price,
        gesture.current.price,
      )
      // A trade drawn with no width still has to be visible and grabbable, so
      // a box that spans no time is given a nominal duration. Ten bars is
      // TradingView's own default and reads as "a trade", not as a line.
      const spacing = medianBarSpacingMs(candles) ?? INTERVAL_MS[interval]
      const endTime =
        gesture.current.time > gesture.start.time
          ? gesture.current.time
          : gesture.start.time + spacing * 10
      onCreateDrawing({
        kind: tool,
        symbol,
        color: drawingColor,
        width: drawingWidth,
        entry: gesture.start,
        endTime,
        stop,
        target,
      })
      onGestureComplete(true)
      return
    } else if (
      tool === 'trendline' ||
      tool === 'rectangle' ||
      tool === 'ray' ||
      tool === 'arrow' ||
      tool === 'fib'
    ) {
      // Measured on the *snapped* endpoints, not on the raw pointer path.
      // `moved` above is a pixel test taken before snapping, and snapping can
      // pull two distinct positions onto one market point -- the bar snap
      // always, the swing snap within 14px, which is more than three times
      // the drag threshold. The shape was then stored with `from === to`: it
      // painted nothing, yet stayed selected, clickable and listed, which is
      // exactly "the zone is not showing, but I can delete it".
      if (!isVisiblySized(tool, gesture.start, gesture.current)) {
        onGestureComplete(false)
        return
      }
      onCreateDrawing({
        kind: tool,
        symbol,
        color: drawingColor,
        width: drawingWidth,
        from: gesture.start,
        to: gesture.current,
      })
      onGestureComplete(true)
      return
    }

    onGestureComplete(true)
  }

  // ---- escape ----------------------------------------------------------
  // Abandoning a gesture has to work while the button is still down, which is
  // the whole reason a mis-click is now recoverable. Listening in the capture
  // phase and stopping the event keeps the window-level shortcuts from also
  // reacting to the same keystroke.
  useEffect(() => {
    if (!pending && !drag) return

    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      updatePending(null)
      updateDrag(null)
      onGestureComplete(false)
    }

    window.addEventListener('keydown', cancel, { capture: true })
    return () => window.removeEventListener('keydown', cancel, { capture: true })
  }, [drag, onGestureComplete, pending, updateDrag, updatePending])

  return (
    <canvas
      ref={canvasRef}
      // `h-full w-full` rather than `inset-0` alone. A canvas is a *replaced*
      // element, so with `width: auto` it keeps its intrinsic 300x150 and the
      // `right`/`bottom` offsets are dropped instead of stretching it (CSS 2.1
      // 10.3.8) -- the rule that makes `inset-0` work for a div does not apply
      // here. The box only ever reached pane size as a side effect of `draw`
      // assigning `style.width`, and `draw` runs from a `requestAnimationFrame`
      // callback, which a tab the compositor is not drawing never runs. Load
      // the app in a background tab and the overlay stayed 300x150 in the
      // top-left corner: the tools answered the pointer inside that square and
      // nowhere else, so a drag anywhere over the candles panned the chart
      // instead of drawing a line, an arrow or a zone. How big the element is
      // is CSS's business, so it is stated in CSS and no longer depends on a
      // frame ever being painted.
      className="absolute inset-0 z-10 h-full w-full"
      style={{
        // Only a held tool takes the pointer. Everything else -- selecting,
        // moving and reshaping -- is intercepted on the parent, which leaves
        // the chart's pan, zoom and wheel untouched even over a drawing.
        pointerEvents: drawingActive ? 'auto' : 'none',
        cursor: drawingActive ? 'crosshair' : 'default',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      // A cancelled pointer -- the browser taking over for a scroll or a
      // system gesture -- is an interruption, not a release. Running the
      // commit path on it placed a shape the user never finished drawing.
      onPointerCancel={handlePointerCancel}
    />
  )
}

/**
 * What the pointer looks like tells you what the next press will do: a corner
 * can be grabbed, a body can be moved, and anywhere else the chart pans.
 * Empty string rather than `default`, so the chart keeps its own cursor.
 */
function cursorFor(drag: ActiveDrag | null, hover: DrawingHit | null): string {
  if (drag) return drag.hit.part === 'point' ? 'grabbing' : 'move'
  if (hover) return hover.part === 'point' ? 'grab' : 'move'
  return ''
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

/**
 * A range's tab: what it is, and a cross that removes it.
 *
 * Drawn on the canvas rather than as a DOM button because it has to sit in
 * the chart's own coordinate space over the candles, and because everything
 * else on this surface is already painted here -- a floating element would be
 * a second layer to keep in step with the first.
 */
function paintRangeChip(
  ctx: CanvasRenderingContext2D,
  chip: RangeChip,
  palette: ChartPalette,
  accent: string,
) {
  ctx.save()

  ctx.globalAlpha = 0.88
  ctx.fillStyle = palette.background
  ctx.fillRect(chip.x, chip.y, chip.width, chip.height)

  ctx.globalAlpha = 0.75
  ctx.strokeStyle = accent
  ctx.lineWidth = 1
  ctx.strokeRect(chip.x + 0.5, chip.y + 0.5, chip.width - 1, chip.height - 1)

  ctx.globalAlpha = 0.95
  ctx.fillStyle = palette.text
  ctx.font = '9px ui-monospace, monospace'
  ctx.textBaseline = 'middle'
  ctx.fillText(chip.label, chip.x + 5, chip.y + chip.height / 2)

  // The cross, drawn as two strokes rather than as a glyph so it lands on
  // exact pixels at any device ratio.
  const crossX = chip.x + chip.width - 9
  const middle = chip.y + chip.height / 2
  ctx.strokeStyle = palette.text
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.moveTo(crossX - 3, middle - 3)
  ctx.lineTo(crossX + 3, middle + 3)
  ctx.moveTo(crossX + 3, middle - 3)
  ctx.lineTo(crossX - 3, middle + 3)
  ctx.stroke()

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

/**
 * The stretch of history the backtest is not allowed to search.
 *
 * Drawn as a veil over everything outside the window rather than by hiding
 * the bars: Miles was explicit that narrowing the test must not take candles
 * off the chart -- the context either side of a run is how you tell whether
 * the run was asking a sensible question. Veiled, those bars are still there
 * to read, and visibly out of scope.
 */
function paintTestWindow(
  ctx: CanvasRenderingContext2D,
  window: TimeWindow,
  xOf: XConverter,
  width: number,
  height: number,
  palette: ChartPalette,
) {
  const left = xOf(window.start_time)
  const right = xOf(window.end_time)
  if (left == null || right == null) return

  const start = Math.min(left, right)
  const end = Math.max(left, right)

  ctx.save()
  ctx.fillStyle = palette.background
  ctx.globalAlpha = 0.62
  if (start > 0) ctx.fillRect(0, 0, start, height)
  if (end < width) ctx.fillRect(end, 0, width - end, height)

  ctx.globalAlpha = 0.9
  ctx.strokeStyle = palette.muted
  ctx.lineWidth = 1
  ctx.setLineDash([4, 3])
  ctx.beginPath()
  ctx.moveTo(start + 0.5, 0)
  ctx.lineTo(start + 0.5, height)
  ctx.moveTo(end - 0.5, 0)
  ctx.lineTo(end - 0.5, height)
  ctx.stroke()

  ctx.setLineDash([])
  ctx.globalAlpha = 0.75
  ctx.fillStyle = palette.text
  ctx.font = '9px ui-monospace, monospace'
  ctx.textBaseline = 'top'
  ctx.fillText('test window', start + 4, 4)
  ctx.restore()
}

/** A faint bracket over the bars a selected trade is being explained from. */
function paintEvidenceWindow(
  ctx: CanvasRenderingContext2D,
  window: TimeWindow,
  xOf: XConverter,
  height: number,
  palette: ChartPalette,
) {
  const left = xOf(window.start_time)
  const right = xOf(window.end_time)
  if (left == null || right == null) return

  const start = Math.min(left, right)
  const span = Math.max(2, Math.abs(right - left))

  ctx.save()
  ctx.globalAlpha = 0.08
  ctx.fillStyle = palette.accent
  ctx.fillRect(start, 0, span, height)
  ctx.restore()
}

interface PositionStyle {
  selected: boolean
  dimmed: boolean
}

/**
 * One trade, as the position tool it would have been drawn with by hand.
 *
 * Reward above the entry and risk below it (mirrored for a short), the box
 * running from entry to exit so its width *is* the holding period. The
 * outcome is written on it rather than left to colour alone, because green
 * and red are the two colours a candle chart has already spent.
 */
function paintPosition(
  ctx: CanvasRenderingContext2D,
  box: PositionBox,
  xOf: XConverter,
  yOf: YConverter,
  palette: ChartPalette,
  { selected, dimmed }: PositionStyle,
): ProjectedPosition | null {
  const x1 = xOf(box.from)
  const x2 = xOf(box.to)
  const entryY = yOf(box.entry)
  const stopY = yOf(box.stop)
  const targetY = yOf(box.target)
  if (x1 == null || x2 == null || entryY == null || stopY == null || targetY == null) {
    return null
  }

  const left = Math.min(x1, x2)
  const span = Math.max(MIN_POSITION_WIDTH_PX, Math.abs(x2 - x1))
  const right = left + span

  const rewardTop = Math.min(entryY, targetY)
  const rewardHeight = Math.max(1, Math.abs(targetY - entryY))
  const riskTop = Math.min(entryY, stopY)
  const riskHeight = Math.max(1, Math.abs(stopY - entryY))

  ctx.save()

  const base = selected ? 0.26 : dimmed ? 0.07 : 0.16
  ctx.globalAlpha = base
  ctx.fillStyle = palette.bull
  ctx.fillRect(left, rewardTop, span, rewardHeight)
  ctx.fillStyle = palette.bear
  ctx.fillRect(left, riskTop, span, riskHeight)

  ctx.globalAlpha = dimmed ? 0.35 : 0.85
  ctx.lineWidth = selected ? 1.6 : 1
  ctx.strokeStyle = palette.bull
  ctx.strokeRect(left + 0.5, rewardTop + 0.5, span - 1, rewardHeight - 1)
  ctx.strokeStyle = palette.bear
  ctx.strokeRect(left + 0.5, riskTop + 0.5, span - 1, riskHeight - 1)

  // The entry runs the full width of the box: it is the one price the trade
  // was actually opened at, and every other line is measured from it.
  ctx.globalAlpha = dimmed ? 0.5 : 1
  ctx.strokeStyle = palette.text
  ctx.lineWidth = selected ? 2 : 1.2
  ctx.beginPath()
  ctx.moveTo(left, entryY + 0.5)
  ctx.lineTo(right, entryY + 0.5)
  ctx.stroke()

  // Where it actually closed, which is only the stop or the target when the
  // trade ran to one of them.
  const exitY = yOf(box.exit)
  if (exitY != null) {
    ctx.fillStyle = box.won ? palette.bull : palette.bear
    ctx.beginPath()
    ctx.arc(right, exitY, selected ? 3.5 : 2.5, 0, Math.PI * 2)
    ctx.fill()
  }

  if (!dimmed) {
    const sign = box.netReturn >= 0 ? '+' : ''
    const label = `#${box.tradeNumber} ${box.isLong ? 'Long' : 'Short'} ${sign}${box.netReturn.toFixed(2)}%`
    ctx.globalAlpha = 0.95
    ctx.font = selected
      ? '600 10px ui-monospace, monospace'
      : '9px ui-monospace, monospace'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = palette.text
    ctx.fillText(label, left, Math.min(rewardTop, riskTop) - 3)
  }

  ctx.restore()

  return {
    id: box.id,
    left,
    right,
    top: Math.min(rewardTop, riskTop),
    bottom: Math.max(rewardTop + rewardHeight, riskTop + riskHeight),
  }
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

/**
 * A shelf of equal highs or lows -- the level, and how many times it held.
 *
 * Drawn as a line rather than a zone even though a pool has a spread. The
 * spread is how *tight* the shelf is, which is a property of the level worth
 * knowing but not worth two pixels of chart: what a trader acts on is the one
 * price that clears it, and a band invites the eye to read the near edge as
 * the level when the far edge is the one that matters.
 *
 * A standing shelf runs to the right edge, because it is still there. A swept
 * one stops where it was taken and fades -- the orders are gone, and the only
 * reason to keep it on the chart is to see where price has already been.
 */
function paintLiquidityPool(
  ctx: CanvasRenderingContext2D,
  pool: LiquidityPool,
  xOf: XConverter,
  yOf: YConverter,
  width: number,
  palette: ChartPalette,
) {
  const y = yOf(pool.price)
  if (y == null) return

  const left = xOf(pool.start_time)
  if (left == null) return
  const right = pool.swept ? (xOf(pool.swept_time ?? pool.end_time) ?? width) : width
  if (right <= left) return

  // Highs are where a long is going and where a short is defended, so they
  // take the bearish colour and lows the bullish one -- the same convention
  // the gaps use, read from which side of price the level sits on.
  const colour = pool.kind === 'high' ? palette.bear : palette.bull

  ctx.save()
  ctx.globalAlpha = pool.swept ? 0.28 : 0.7
  ctx.strokeStyle = colour
  ctx.lineWidth = 1
  // Dashed while it stands, because it is a level price has not reached yet;
  // solid once taken, because that part is history and did happen.
  ctx.setLineDash(pool.swept ? [] : [5, 4])
  ctx.beginPath()
  ctx.moveTo(left, y + 0.5)
  ctx.lineTo(right, y + 0.5)
  ctx.stroke()
  ctx.setLineDash([])

  // A tick per pivot at the left end: how many times the level held is the
  // difference between a shelf worth targeting and a coincidence.
  ctx.globalAlpha = pool.swept ? 0.35 : 0.85
  ctx.fillStyle = colour
  for (let index = 0; index < Math.min(pool.touch_count, 5); index += 1) {
    ctx.fillRect(left + index * 4, y - 2.5, 2, 5)
  }
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

/**
 * A retracement: the two swings, and the levels between them.
 *
 * The levels run to the right edge rather than stopping at the second swing,
 * because what the tool is *for* is watching price come back to one of them
 * later -- a retracement that stops where the move stopped can only describe
 * the past. The hit test extends the same way, so a level is grabbable
 * wherever it is drawn.
 */
function paintFib(
  ctx: CanvasRenderingContext2D,
  projected: ProjectedSegment,
  drawing: FibDrawing,
  width: number,
) {
  const left = Math.min(projected.x1, projected.x2)
  const levels = fibLevels(drawing.from, drawing.to)

  // The move itself, faint: it is context for the levels rather than a level.
  ctx.save()
  ctx.globalAlpha = 0.35
  ctx.setLineDash([3, 3])
  ctx.beginPath()
  ctx.moveTo(projected.x1, projected.y1)
  ctx.lineTo(projected.x2, projected.y2)
  ctx.stroke()
  ctx.restore()

  ctx.save()
  ctx.font = '9px ui-monospace, monospace'
  ctx.textBaseline = 'bottom'
  for (let index = 0; index < levels.length; index += 1) {
    const { ratio } = levels[index]
    const y = projected.y2 + (projected.y1 - projected.y2) * ratio

    // The extremes are the swings themselves and are drawn solid; the
    // retracements between them are dashed, so the two read as what they are.
    ctx.globalAlpha = ratio === 0 || ratio === 1 ? 0.9 : 0.55
    ctx.setLineDash(ratio === 0 || ratio === 1 ? [] : [5, 4])
    ctx.beginPath()
    ctx.moveTo(left, y + 0.5)
    ctx.lineTo(width, y + 0.5)
    ctx.stroke()

    ctx.globalAlpha = 0.85
    ctx.fillText(`${ratio.toFixed(3)}  ${levels[index].price.toFixed(2)}`, left + 4, y - 2)
  }
  ctx.restore()
}

/**
 * A planned trade: reward above the entry, risk below it, or the other way up.
 *
 * Filled in two colours because the question the box answers is "how much am
 * I risking against how much am I making", and that is read from the relative
 * size of the two blocks long before any number on it is.
 */
function paintPlannedTrade(
  ctx: CanvasRenderingContext2D,
  projected: ProjectedPlannedTrade,
  drawing: PositionDrawing,
  palette: ChartPalette,
) {
  const left = Math.min(projected.x1, projected.x2)
  const right = Math.max(projected.x1, projected.x2)
  const boxWidth = Math.max(MIN_POSITION_WIDTH_PX, right - left)
  const { yEntry, yStop, yTarget } = projected

  ctx.save()

  ctx.globalAlpha = 0.16
  ctx.fillStyle = palette.bull
  ctx.fillRect(left, Math.min(yEntry, yTarget), boxWidth, Math.abs(yTarget - yEntry))
  ctx.fillStyle = palette.bear
  ctx.fillRect(left, Math.min(yEntry, yStop), boxWidth, Math.abs(yStop - yEntry))

  ctx.globalAlpha = 0.95
  ctx.lineWidth = drawing.width
  for (const [y, colour] of [
    [yEntry, drawing.color],
    [yTarget, palette.bull],
    [yStop, palette.bear],
  ] as const) {
    ctx.strokeStyle = colour
    ctx.beginPath()
    ctx.moveTo(left, y + 0.5)
    ctx.lineTo(left + boxWidth, y + 0.5)
    ctx.stroke()
  }

  /*
   * Risk, reward and the ratio between them.
   *
   * The ratio is the number that decides whether a trade is worth taking, and
   * it is the one a hand-drawn box exists to work out -- so it is printed
   * rather than left to be measured off the axis. Guarded, because a stop
   * dragged onto the entry makes the risk zero and the ratio meaningless; the
   * honest answer there is to say nothing rather than to print a division.
   */
  const risk = Math.abs(drawing.entry.price - drawing.stop)
  const reward = Math.abs(drawing.target - drawing.entry.price)
  const label =
    risk > 0
      ? `${drawing.kind === 'long' ? 'Long' : 'Short'}  ${(reward / risk).toFixed(2)}R`
      : `${drawing.kind === 'long' ? 'Long' : 'Short'}  no risk set`

  ctx.globalAlpha = 0.9
  ctx.fillStyle = palette.text
  ctx.font = '9px ui-monospace, monospace'
  ctx.textBaseline = 'bottom'
  ctx.fillText(label, left + 4, Math.min(yTarget, yStop) - 3)

  ctx.restore()
}

interface DrawingStyle {
  selected: boolean
  hovered: boolean
  /** Pane colour, used to punch out the middle of a grab handle. */
  background: string
  /** The pane's own palette, for shapes that mean up and down. */
  palette: ChartPalette
}

function paintDrawing(
  ctx: CanvasRenderingContext2D,
  drawing: Drawing,
  xOf: XConverter,
  yOf: YConverter,
  width: number,
  height: number,
  { selected, hovered, background, palette }: DrawingStyle,
): boolean {
  // Painted from the same projection the pointer is tested against, so a grip
  // is never drawn somewhere it cannot actually be grabbed.
  const projected = projectDrawing(drawing, xOf, yOf)
  if (!projected) return false

  const priceLabel = drawing.kind === 'horizontal' ? drawing.price.toFixed(2) : null

  ctx.save()
  ctx.strokeStyle = drawing.color
  ctx.fillStyle = drawing.color
  // Selection and hover *add* to the chosen width rather than replacing it,
  // so a deliberately hairline level stays hairline when you pick it up.
  ctx.lineWidth = drawing.width + (selected ? 0.9 : hovered ? 0.5 : 0)
  ctx.setLineDash([])

  if (projected.kind === 'horizontal') {
    const y = projected.y
    ctx.beginPath()
    ctx.moveTo(0, y + 0.5)
    ctx.lineTo(width, y + 0.5)
    ctx.stroke()

    if (priceLabel) {
      ctx.globalAlpha = 0.85
      ctx.font = '9px ui-monospace, monospace'
      ctx.textBaseline = 'bottom'
      ctx.fillText(priceLabel, 4, y - 2)
    }
  } else if (projected.kind === 'text') {
    const label = drawing.kind === 'text' ? drawing.text : ''
    const boxWidth = projected.chars * TEXT_CHAR_PX + 8
    // A quiet plate behind the words: a note over candles is unreadable
    // without one, and an opaque block would hide the bars it annotates.
    ctx.globalAlpha = 0.72
    ctx.fillStyle = background
    ctx.fillRect(projected.x - 4, projected.y - TEXT_LINE_PX, boxWidth, TEXT_LINE_PX + 4)
    ctx.globalAlpha = 1
    ctx.strokeStyle = drawing.color
    ctx.strokeRect(
      projected.x - 3.5,
      projected.y - TEXT_LINE_PX + 0.5,
      boxWidth - 1,
      TEXT_LINE_PX + 3,
    )
    ctx.fillStyle = drawing.color
    ctx.font = '11px ui-monospace, monospace'
    ctx.textBaseline = 'alphabetic'
    ctx.fillText(label, projected.x, projected.y - 3)
  } else if (projected.kind === 'horizontal_ray') {
    // Forward only: the level did not exist before the bar that made it.
    ctx.beginPath()
    ctx.moveTo(projected.x, projected.y + 0.5)
    ctx.lineTo(width, projected.y + 0.5)
    ctx.stroke()

    ctx.globalAlpha = 0.85
    ctx.font = '9px ui-monospace, monospace'
    ctx.textBaseline = 'bottom'
    ctx.fillText(
      drawing.kind === 'horizontal_ray' ? drawing.from.price.toFixed(2) : '',
      projected.x + 4,
      projected.y - 2,
    )
  } else if (projected.kind === 'vertical') {
    const x = projected.x
    ctx.beginPath()
    ctx.moveTo(x + 0.5, 0)
    ctx.lineTo(x + 0.5, height)
    ctx.stroke()
  } else if (projected.kind === 'brush') {
    // One path through every point. Round joins and caps because a freehand
    // line drawn with mitred corners looks like a polygon, which is exactly
    // what it is and exactly what it should not look like.
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(projected.points[0].x, projected.points[0].y)
    for (const point of projected.points.slice(1)) ctx.lineTo(point.x, point.y)
    // A stroke of one point would paint nothing, so it is given a dot.
    if (projected.points.length === 1) {
      ctx.lineTo(projected.points[0].x + 0.1, projected.points[0].y)
    }
    ctx.stroke()
  } else if (isProjectedPosition(projected)) {
    paintPlannedTrade(ctx, projected, drawing as PositionDrawing, palette)
  } else if (projected.kind === 'fib') {
    paintFib(ctx, projected, drawing as FibDrawing, width)
  } else if (projected.kind === 'rectangle') {
    const left = Math.min(projected.x1, projected.x2)
    const top = Math.min(projected.y1, projected.y2)
    // A floor, as every other rectangle painter in this file has: a zone that
    // rounds to zero on one side would otherwise be stored, selectable and
    // completely invisible.
    const boxWidth = Math.max(MIN_SHAPE_PX, Math.abs(projected.x2 - projected.x1))
    const boxHeight = Math.max(MIN_SHAPE_PX, Math.abs(projected.y2 - projected.y1))
    ctx.globalAlpha = hovered || selected ? 0.2 : 0.14
    ctx.fillRect(left, top, boxWidth, boxHeight)
    ctx.globalAlpha = 1
    ctx.strokeRect(left + 0.5, top + 0.5, boxWidth, boxHeight)

    if (drawing.kind === 'rectangle' && drawing.midline) {
      // Dashed, because it is a level *implied* by the zone rather than an
      // edge of it, and the two should not read as the same kind of line.
      const middle = top + boxHeight / 2
      ctx.save()
      ctx.setLineDash([4, 3])
      ctx.globalAlpha = 0.9
      ctx.beginPath()
      ctx.moveTo(left, middle + 0.5)
      ctx.lineTo(left + boxWidth, middle + 0.5)
      ctx.stroke()
      ctx.restore()
    }
  } else {
    // Trend line, ray and arrow: one segment, differing only in what happens
    // at the ends.
    let { x2, y2 } = projected
    const { x1, y1 } = projected

    if (projected.kind === 'ray') {
      // Continue past the second point to the right edge, keeping the slope.
      const runX = x2 - x1
      const runY = y2 - y1
      if (runX > 0) {
        const scale = (width - x1) / runX
        if (scale > 1) {
          x2 = x1 + runX * scale
          y2 = y1 + runY * scale
        }
      }
    }

    ctx.beginPath()
    ctx.moveTo(x1, y1)
    ctx.lineTo(x2, y2)
    ctx.stroke()

    if (projected.kind === 'arrow') {
      paintArrowhead(ctx, x1, y1, x2, y2, drawing.width)
    }
  }

  // Grips appear on selection rather than on hover, so that the shape you
  // picked is the one advertising what can be dragged.
  if (selected) {
    ctx.globalAlpha = 1
    for (const { x, y } of handlePositions(projected)) {
      ctx.beginPath()
      ctx.arc(x, y, 4, 0, Math.PI * 2)
      ctx.fillStyle = background
      ctx.fill()
      ctx.lineWidth = 1.6
      ctx.strokeStyle = drawing.color
      ctx.stroke()
    }
  }

  ctx.restore()
  return true
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

  if (tool === 'select' || tool === 'window') {
    const left = Math.min(gesture.startX, gesture.currentX)
    const span = Math.abs(gesture.currentX - gesture.startX)
    // The window previews as an outline only: it is about to *exclude* what
    // lies outside it, so filling the inside would say the opposite.
    if (tool === 'select') {
      ctx.fillStyle = accent
      ctx.globalAlpha = 0.16
      ctx.fillRect(left, 0, span, height)
    }
    ctx.globalAlpha = 1
    ctx.strokeStyle = accent
    ctx.strokeRect(left + 0.5, 0.5, span, height - 1)
  } else if (tool === 'trendline' || tool === 'ray' || tool === 'arrow') {
    // The three segment tools preview the same way. The ray's extension is
    // left out on purpose: while the gesture is running the second point is
    // still moving, so an extension would swing across the pane on every
    // pixel and say nothing about where the line will end up.
    ctx.strokeStyle = colour
    ctx.beginPath()
    ctx.moveTo(gesture.startX, gesture.startY)
    ctx.lineTo(gesture.currentX, gesture.currentY)
    ctx.stroke()
  } else if (tool === 'brush') {
    // The stroke as recorded so far, which is also exactly what will be
    // stored -- the preview is the drawing, a step early.
    ctx.strokeStyle = colour
    ctx.setLineDash([])
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(gesture.startX, gesture.startY)
    ctx.lineTo(gesture.currentX, gesture.currentY)
    ctx.stroke()
  } else if (tool === 'vertical') {
    ctx.strokeStyle = colour
    ctx.beginPath()
    ctx.moveTo(gesture.currentX + 0.5, 0)
    ctx.lineTo(gesture.currentX + 0.5, height)
    ctx.stroke()
  } else if (tool === 'horizontal_ray') {
    // Forward only, which is the whole claim the tool makes.
    ctx.strokeStyle = colour
    ctx.beginPath()
    ctx.moveTo(gesture.currentX, gesture.currentY + 0.5)
    ctx.lineTo(width, gesture.currentY + 0.5)
    ctx.stroke()
  } else if (tool === 'text') {
    // The plate the note will sit on, so its size is not a surprise.
    ctx.strokeStyle = colour
    ctx.strokeRect(
      gesture.currentX - 3.5,
      gesture.currentY - TEXT_LINE_PX + 0.5,
      DEFAULT_NOTE.length * TEXT_CHAR_PX + 8,
      TEXT_LINE_PX,
    )
  } else if (tool === 'fib') {
    // Every level, live: where the retracements land is the only reason to
    // pick one pair of swings over another, so it has to be visible before
    // the gesture is committed rather than after.
    ctx.strokeStyle = colour
    for (const { ratio } of fibLevels({ time: 0, price: 1 }, { time: 0, price: 0 })) {
      const y = gesture.currentY + (gesture.startY - gesture.currentY) * ratio
      ctx.globalAlpha = ratio === 0 || ratio === 1 ? 0.9 : 0.5
      ctx.beginPath()
      ctx.moveTo(Math.min(gesture.startX, gesture.currentX), y + 0.5)
      ctx.lineTo(width, y + 0.5)
      ctx.stroke()
    }
  } else if (tool === 'long' || tool === 'short') {
    /*
     * Risk below the entry and reward above it, in the proportions the trade
     * will actually have.
     *
     * Drawn from the *screen* distance rather than by re-deriving prices: the
     * commit does the arithmetic in market coordinates, and doing it twice in
     * two places is how a preview comes to disagree with what it previews.
     * One number links them -- the default reward multiple -- and the stop is
     * placed on the side the direction demands, so a long dragged upwards
     * still previews as a long.
     */
    const risk = Math.abs(gesture.currentY - gesture.startY)
    const down = tool === 'long'
    const stopY = down ? gesture.startY + risk : gesture.startY - risk
    const targetY = down
      ? gesture.startY - risk * DEFAULT_POSITION_R
      : gesture.startY + risk * DEFAULT_POSITION_R
    const left = Math.min(gesture.startX, gesture.currentX)
    const span = Math.max(MIN_POSITION_WIDTH_PX, Math.abs(gesture.currentX - gesture.startX))

    ctx.setLineDash([])
    ctx.globalAlpha = 0.14
    ctx.fillStyle = accent
    ctx.fillRect(left, Math.min(gesture.startY, targetY), span, Math.abs(targetY - gesture.startY))
    ctx.globalAlpha = 0.14
    ctx.fillStyle = colour
    ctx.fillRect(left, Math.min(gesture.startY, stopY), span, Math.abs(stopY - gesture.startY))

    ctx.globalAlpha = 0.9
    ctx.strokeStyle = colour
    ctx.setLineDash([4, 3])
    for (const y of [gesture.startY, stopY, targetY]) {
      ctx.beginPath()
      ctx.moveTo(left, y + 0.5)
      ctx.lineTo(left + span, y + 0.5)
      ctx.stroke()
    }
  } else if (tool === 'horizontal') {
    // Previewed under the cursor before it exists: a level is committed on
    // release, so this is the last look at it before it is real.
    ctx.strokeStyle = colour
    ctx.fillStyle = colour
    ctx.beginPath()
    ctx.moveTo(0, gesture.currentY + 0.5)
    ctx.lineTo(width, gesture.currentY + 0.5)
    ctx.stroke()

    ctx.setLineDash([])
    ctx.globalAlpha = 0.85
    ctx.font = '9px ui-monospace, monospace'
    ctx.textBaseline = 'bottom'
    ctx.fillText(gesture.current.price.toFixed(2), 4, gesture.currentY - 2)
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

/** The head of an arrow, sized from the line it terminates. */
function paintArrowhead(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  lineWidth: number,
) {
  const angle = Math.atan2(y2 - y1, x2 - x1)
  // Scaled to the stroke so a heavy line does not end in a pinhead.
  const size = 6 + lineWidth * 2
  const spread = Math.PI / 7

  ctx.beginPath()
  ctx.moveTo(x2, y2)
  ctx.lineTo(x2 - size * Math.cos(angle - spread), y2 - size * Math.sin(angle - spread))
  ctx.lineTo(x2 - size * Math.cos(angle + spread), y2 - size * Math.sin(angle + spread))
  ctx.closePath()
  ctx.fill()
}

/**
 * A note that some drawings exist but have nowhere to go on this chart.
 *
 * Bottom-left, quiet, and counted rather than named: the point is to replace
 * silence with a fact, not to put a list on the chart.
 */
function paintOffDataNote(
  ctx: CanvasRenderingContext2D,
  count: number,
  height: number,
  palette: ChartPalette,
) {
  const label =
    count === 1
      ? '1 drawing outside the loaded candles'
      : `${count} drawings outside the loaded candles`

  ctx.save()
  ctx.font = '10px ui-monospace, monospace'
  ctx.textBaseline = 'bottom'
  const textWidth = ctx.measureText(label).width

  ctx.globalAlpha = 0.9
  ctx.fillStyle = palette.background
  ctx.fillRect(6, height - 22, textWidth + 12, 16)
  ctx.globalAlpha = 1
  ctx.strokeStyle = palette.muted
  ctx.lineWidth = 1
  ctx.strokeRect(6.5, height - 21.5, textWidth + 11, 15)
  ctx.fillStyle = palette.muted
  ctx.fillText(label, 12, height - 9)
  ctx.restore()
}
