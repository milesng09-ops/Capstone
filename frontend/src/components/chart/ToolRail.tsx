/**
 * Drawing tools, in a rail down the left edge of the charts.
 *
 * They sit here rather than in the top bar because they are a different kind
 * of control: a tool is *held* while you work on the candles, not set once
 * like a symbol or an interval. Putting them along the edge they act on keeps
 * the pointer's round trip short, and frees the top bar to be only about what
 * is charted -- which is how every charting terminal ends up laying this out.
 *
 * The rail is 40px wide, so everything in it is an icon. Every button carries
 * a title with its keyboard-free explanation, since an icon alone never says
 * what "snap" or "zone" means to someone opening this for the first time.
 */

import { Fragment, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import {
  BoxSelect,
  Brush,
  CalendarRange,
  Ruler,
  TrendingDown,
  TrendingUp,
  Magnet,
  Waypoints,
  Minus,
  MousePointer2,
  Palette,
  Redo2,
  Slash,
  Square,
  MoveUpRight,
  ArrowUpRight,
  ArrowRightFromLine,
  Type,
  SeparatorVertical,
  Settings2,
  Maximize2,
  Minimize2,
  Trash2,
  Undo2,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { Button } from '@/components/ui/primitives'
import { useWorkspace } from '@/store/workspace'
import {
  DRAWING_COLORS,
  TOOL_HINTS,
  TOOL_LABELS,
  type ToolMode,
} from '@/types/drawing'
import { CANDLE_COLORS } from '@/types/market'
import { cn } from '@/utils/cn'

const TOOL_ICONS: Record<ToolMode, LucideIcon> = {
  cursor: MousePointer2,
  select: BoxSelect,
  window: CalendarRange,
  trendline: Slash,
  horizontal: Minus,
  rectangle: Square,
  ray: MoveUpRight,
  horizontal_ray: ArrowRightFromLine,
  text: Type,
  vertical: SeparatorVertical,
  arrow: ArrowUpRight,
  fib: Ruler,
  long: TrendingUp,
  short: TrendingDown,
  brush: Brush,
}

/**
 * Pointer, then the two ranges a backtest is made of, then the shapes.
 *
 * Three groups with a rule between them, because they are three different
 * kinds of thing and the middle one is the one that caused trouble: the
 * ranges are not drawings, and sitting flush against the shapes they read as
 * though they were. The ranges are a pair -- what to look for, and where to
 * look for it -- so they stay together.
 *
 * Every tool the overlay implements is listed. Five of them (ray, level from
 * here, arrow, time marker, note) shipped with icons, hit tests and paint
 * code but no button, which made them reachable by nothing at all.
 */
const TOOL_GROUPS: ToolMode[][] = [
  ['cursor'],
  ['select', 'window'],
  [
    'trendline',
    'ray',
    'arrow',
    'horizontal',
    'horizontal_ray',
    'vertical',
    'rectangle',
    'fib',
    'brush',
    'text',
  ],
  // The two position tools are their own group: unlike everything above them
  // they are not annotation, they are a trade written down -- entry, stop and
  // target, with the reward-to-risk read off the box.
  ['long', 'short'],
]

export function ToolRail({ footer }: { footer?: ReactNode }) {
  const tool = useWorkspace((state) => state.tool)
  const drawingColor = useWorkspace((state) => state.drawingColor)
  const snapToSwings = useWorkspace((state) => state.snapToSwings)
  const magnet = useWorkspace((state) => state.magnet)
  const focusMode = useWorkspace((state) => state.focusMode)
  const toggleFocusMode = useWorkspace((state) => state.toggleFocusMode)
  const toggleMagnet = useWorkspace((state) => state.toggleMagnet)
  const showSwings = useWorkspace((state) => state.ict.showSwings)
  const drawingCount = useWorkspace((state) => state.drawings.length)

  const setTool = useWorkspace((state) => state.setTool)
  const setDrawingColor = useWorkspace((state) => state.setDrawingColor)
  const setSnapToSwings = useWorkspace((state) => state.setSnapToSwings)
  const clearDrawings = useWorkspace((state) => state.clearDrawings)

  return (
    <nav
      aria-label="Drawing tools"
      className="panel flex w-10 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-border py-1.5"
    >
      {TOOL_GROUPS.map((group, index) => (
        <Fragment key={group[0]}>
          {index > 0 && <RailDivider />}
          {group.map((mode) => {
            const Icon = TOOL_ICONS[mode]
            return (
              <Button
                key={mode}
                size="icon"
                variant="toolbar"
                data-active={tool === mode}
                onClick={() => setTool(mode)}
                title={`${TOOL_LABELS[mode]} - ${TOOL_HINTS[mode]}`}
                aria-label={TOOL_LABELS[mode]}
                aria-pressed={tool === mode}
              >
                <Icon size={15} />
              </Button>
            )
          })}
        </Fragment>
      ))}

      <RailDivider />

      {/*
        "The screen is a bit small." Both panels already closed one at a time;
        this closes them together and gives them back, without asking anyone
        to remember what had been open.
      */}
      <Button
        size="icon"
        variant="toolbar"
        data-active={focusMode}
        onClick={toggleFocusMode}
        title={focusMode ? 'Show the panels again (F or Esc)' : 'Just the charts (F)'}
        aria-label="Focus on the charts"
        aria-pressed={focusMode}
      >
        {focusMode ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
      </Button>

      <ChartSettingsMenu />

      <ColorPicker value={drawingColor} onChange={setDrawingColor} />

      {/*
        The magnet every charting platform means by the word: drawing points
        land on a bar's open, high, low or close instead of wherever the
        pointer happened to be. Marking "this low took that low" is an exact
        claim about exact numbers, and without it the only way to make the
        endpoint land on the low is to zoom until one pixel is one tick.
      */}
      <Button
        size="icon"
        variant="toolbar"
        data-active={magnet}
        onClick={toggleMagnet}
        title="Magnet — snap drawing points to a candle's open, high, low or close"
        aria-label="Magnet"
        aria-pressed={magnet}
      >
        <Magnet size={15} />
      </Button>

      {/*
        A *different* snap, and deliberately a different control: this one
        reaches only the swing points the chart is drawing, so with them
        hidden -- which is the default -- it has nothing to act on. Left merely
        lit it was a switch that visibly did nothing; disabled and explained,
        it says what to turn on to make it work.
      */}
      <Button
        size="icon"
        variant="toolbar"
        data-active={snapToSwings && showSwings}
        disabled={!showSwings}
        onClick={() => setSnapToSwings(!snapToSwings)}
        title={
          showSwings
            ? 'Snap drawings to nearby swing points'
            : 'Snapping needs the swing points on screen — turn them on under Analysis'
        }
        aria-label="Snap to swing points"
        aria-pressed={snapToSwings && showSwings}
      >
        <Waypoints size={15} />
      </Button>

      <RailDivider />

      <Button
        size="icon"
        variant="toolbar"
        onClick={() => clearDrawings()}
        disabled={drawingCount === 0}
        title="Remove every drawing"
        aria-label="Clear drawings"
      >
        <Trash2 size={15} />
      </Button>

      <HistoryButtons />

      {/*
       * On a phone this rail is the only one, so it also carries the way into
       * the side panels. They go at the bottom, behind a divider: the tools
       * above are what the rail is *for*, and pushing them down to make room
       * for navigation would cost the drawing buttons their muscle memory.
       */}
      {footer && (
        <>
          <RailDivider />
          {footer}
        </>
      )}
    </nav>
  )
}

function RailDivider() {
  return <span className="my-1 h-px w-5 shrink-0 bg-border" />
}

/** Undo and redo over the drawing history the store keeps. */
function HistoryButtons() {
  const undo = useWorkspace((state) => state.undoDrawings)
  const redo = useWorkspace((state) => state.redoDrawings)
  const canUndo = useWorkspace((state) => state.past.length > 0)
  const canRedo = useWorkspace((state) => state.future.length > 0)

  return (
    <>
      <Button
        size="icon"
        variant="toolbar"
        onClick={undo}
        disabled={!canUndo}
        title="Undo the last change to the drawings"
        aria-label="Undo"
      >
        <Undo2 size={15} />
      </Button>
      <Button
        size="icon"
        variant="toolbar"
        onClick={redo}
        disabled={!canRedo}
        title="Redo the change that was undone"
        aria-label="Redo"
      >
        <Redo2 size={15} />
      </Button>
    </>
  )
}

/**
 * The drawing colour, as a swatch that opens a flyout.
 *
 * Six swatches stacked in a 40px rail would be a third of its height spent on
 * a setting that is changed rarely, so the rail shows only the current colour
 * and the rest appear beside it on demand.
 */
function ColorPicker({
  value,
  onChange,
}: {
  value: string
  onChange: (color: string) => void
}) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Close on an outside press or on Escape, the two ways anyone expects to
  // dismiss a popover without choosing from it.
  useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={rootRef} className="relative">
      <Button
        size="icon"
        variant="toolbar"
        onClick={() => setOpen((current) => !current)}
        title="Colour used by the next drawing"
        aria-label="Drawing colour"
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span className="relative">
          <Palette size={15} />
          <span
            className="absolute -bottom-1.5 left-0 h-1 w-full rounded-full"
            style={{ backgroundColor: value }}
          />
        </span>
      </Button>

      {open && (
        <div
          role="group"
          aria-label="Drawing colour"
          className="absolute left-full top-0 z-40 ml-1 grid grid-cols-3 gap-1 rounded border border-border bg-[hsl(var(--popover))] p-1.5 shadow-lg"
        >
          {DRAWING_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Use colour ${color}`}
              aria-pressed={color === value}
              onClick={() => {
                onChange(color)
                setOpen(false)
              }}
              style={{ backgroundColor: color }}
              className={cn(
                'h-4 w-4 rounded-full border transition-transform',
                color === value
                  ? 'scale-110 border-foreground'
                  : 'border-transparent hover:scale-110',
              )}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * How the chart looks, as opposed to what is on it.
 *
 * A trader reads a chart they have set up to their own eye. Miles works on a
 * white background with no grid and black-and-white candles; every glance at
 * a chart dressed differently costs him a translation. None of this touches
 * the data.
 */
function ChartSettingsMenu() {
  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape)
    }
  }, [open])

  return (
    <div ref={boxRef} className="relative">
      <Button
        size="icon"
        variant="toolbar"
        data-active={open}
        onClick={() => setOpen((was) => !was)}
        title="Chart appearance — grid, volume, candle colours"
        aria-label="Chart appearance"
        aria-expanded={open}
      >
        <Settings2 size={15} />
      </Button>

      {open && (
        <div className="absolute left-full top-0 z-40 ml-1 w-44 rounded-md border border-border bg-[hsl(var(--popover))] p-2 shadow-lg">
          <ChartSettingsBody />
        </div>
      )}
    </div>
  )
}

/**
 * The settings themselves, independent of how they were reached.
 *
 * Miles asked for these on right-click, which is where every charting
 * platform puts them. They are also on the rail, because a right-click menu
 * is invisible until you try it. Same controls either way -- two doors, one
 * room, and no second copy to drift out of step with the first.
 */
export function ChartSettingsBody() {
  const settings = useWorkspace((state) => state.chartSettings)
  const update = useWorkspace((state) => state.updateChartSettings)
  const sync = useWorkspace((state) => state.chartSync)
  const updateSync = useWorkspace((state) => state.updateChartSync)

  return (
    <div className="space-y-2">
      <SettingRow
        label="Grid lines"
        checked={settings.showGrid}
        onChange={(showGrid) => update({ showGrid })}
      />
      <SettingRow
        label="Volume"
        checked={settings.showVolume}
        onChange={(showVolume) => update({ showVolume })}
      />

      <CandleColorRow
        label="Up candles"
        value={settings.bullColor}
        onChange={(bullColor) => update({ bullColor })}
      />
      <CandleColorRow
        label="Down candles"
        value={settings.bearColor}
        onChange={(bearColor) => update({ bearColor })}
      />

      {/*
        Three separate links, because they are three different claims. The
        crosshair is the one that matters most: reading an SMT divergence
        means having the cursor on the *same candle* on both markets, and
        without that you are comparing different moments and inventing
        divergences that are not there.
      */}
      <div className="border-t border-border pt-2">
        <div className="label-caps pb-1">Link charts</div>
        <SettingRow
          label="Crosshair"
          checked={sync.crosshair}
          onChange={(crosshair) => updateSync({ crosshair })}
        />
        <SettingRow
          label="Time"
          checked={sync.time}
          onChange={(time) => updateSync({ time })}
        />
        <SettingRow
          label="Interval"
          checked={sync.interval}
          onChange={(interval) => updateSync({ interval })}
        />
        <p className="pt-1 text-[10px] leading-snug text-muted">
          {sync.interval
            ? 'Every chart is on the same bar size.'
            : 'Each chart keeps its own bar size; set it on the chart.'}
        </p>
      </div>
    </div>
  )
}

function SettingRow({
  label,
  checked,
  onChange,
}: {
  label: string
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between text-2xs">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="h-3 w-3 accent-[hsl(var(--primary))]"
      />
    </label>
  )
}

/** `null` follows the theme, which keeps tracking light and dark. */
function CandleColorRow({
  label,
  value,
  onChange,
}: {
  label: string
  value: string | null
  onChange: (value: string | null) => void
}) {
  return (
    <div className="space-y-1">
      <span className="text-2xs text-muted-foreground">{label}</span>
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => onChange(null)}
          aria-pressed={value == null}
          title="Follow the theme"
          className={cn(
            'h-4 rounded px-1 text-[9px] transition-colors',
            value == null
              ? 'bg-[hsl(var(--panel-raised))] text-foreground'
              : 'text-muted-foreground hover:bg-[hsl(var(--panel-raised))]',
          )}
        >
          auto
        </button>
        {CANDLE_COLORS.map((color) => (
          <button
            key={color}
            type="button"
            aria-label={`${label} ${color}`}
            aria-pressed={color === value}
            onClick={() => onChange(color)}
            style={{ backgroundColor: color }}
            className={cn(
              'h-3.5 w-3.5 rounded-full border transition-transform',
              color === value
                ? 'scale-110 border-foreground'
                : 'border-border hover:scale-110',
            )}
          />
        ))}
      </div>
    </div>
  )
}
