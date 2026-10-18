/**
 * Workspace state: what is on screen, what is drawn on it, and what the next
 * backtest will run.
 *
 * Chart settings and drawings are persisted to localStorage. A trader who
 * marked up a chart and then refreshed should not lose the markup -- and since
 * drawings are stored in market coordinates, they land back on the same
 * candles. Backtest *results* are deliberately not persisted; they are server
 * state and are refetched by id.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

import {
  DEFAULT_DRAWING_COLOR,
  DEFAULT_DRAWING_WIDTH,
  type Drawing,
  type ToolMode,
} from '@/types/drawing'
import { DEFAULT_ICT_SETTINGS, type IctSettings } from '@/types/ict'
import {
  DEFAULT_DETECTOR_FILTERS,
  DEFAULT_GXT_SETTINGS,
  type GxtSettings,
  type StrategyKind,
  DEFAULT_LEARNING_SETTINGS,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_SIZING,
  DEFAULT_TRADE_RULES,
  type SearchConfig,
  type SizingConfig,
  type DetectorFilters,
  type LearningSettings,
  type TradeRules,
} from '@/types/backtest'
import {
  DEFAULT_CHART_SETTINGS,
  DEFAULT_CHART_SYNC,
  DEFAULT_FAVOURITE_INTERVALS,
  INTERVALS,
  MAX_RANGE_DAYS,
  validBiasInterval,
} from '@/types/market'
import type {
  ChartSettings,
  ChartSync,
  Interval,
  SelectionRange,
  SymbolKey,
  TimeWindow,
} from '@/types/market'
import { setSyncModes } from '@/lib/chartSync'
import { setFormattingTimeZone } from '@/utils/format'
import {
  DEFAULT_EXCHANGE_ZONE,
  EXCHANGE_TIME_ZONE,
  isKnownTimeZone,
  resolveTimeZone,
  type TimeZoneId,
} from '@/utils/timezone'

/** Which panel is docked in the right-hand column. */
export type SidePanel = 'analysis' | 'strategy'

/**
 * History loaded into the chart, in days.
 *
 * The two short presets exist for the minute intervals: a 1m chart runs out
 * of stored bars in three weeks and Yahoo only keeps a week of them, so
 * without something under 30 the shortest offer would already be too long.
 */
export const RANGE_PRESETS = [7, 14, 30, 60, 90, 180, 365, 730] as const
export type RangeDays = (typeof RANGE_PRESETS)[number]

/**
 * The longest preset an interval can actually serve.
 *
 * Finer intervals hold more bars in the same wall-clock window, and past a
 * point the backend refuses the request outright. Clamping here is what keeps
 * the workspace in a state that can be loaded: switching to 5m while 180 days
 * are selected used to leave every chart showing an error until the user
 * worked out that the range, not the interval, was the problem.
 */
/**
 * A coarser interval made of whole entry bars, preferring `wanted`.
 *
 * The backend requires the higher timeframe to divide into whole entry
 * bars, and the two settings are changed from opposite
 * ends of the screen, so this keeps the pair legal without either control
 * having to know about the other.
 *
 * With weekly or monthly entry bars no valid higher interval remains. The
 * same interval is returned, which is why `canReadBias` below
 * exists rather than leaving the run to fail at the backend.
 */
export function coarserOf(wanted: Interval, base: Interval): Interval {
  if (validBiasInterval(base, wanted)) return wanted
  return INTERVALS.find((item) => validBiasInterval(base, item)) ?? base
}

/** Whether any higher interval can be assembled from whole entry bars. */
export function canReadBias(base: Interval): boolean {
  return INTERVALS.some((item) => validBiasInterval(base, item))
}

export function longestRange(interval: Interval): RangeDays {
  const cap = MAX_RANGE_DAYS[interval]
  const usable = RANGE_PRESETS.filter((days) => days <= cap)
  return usable[usable.length - 1] ?? RANGE_PRESETS[0]
}

/**
 * How the charted markets are arranged on screen.
 *
 * `stacked` is the default because SMT divergence is read straight down a
 * vertical line -- the same candle on NQ and on ES, one above the other --
 * and only stacking puts them on a shared time axis you can sight along.
 * `columns` trades that away for height, which is what you want when the
 * question is about the shape of one market rather than two. `grid` is for
 * three charts on a wide screen.
 */
export const CHART_LAYOUTS = ['stacked', 'columns', 'grid'] as const
export type ChartLayout = (typeof CHART_LAYOUTS)[number]

/**
 * Undo steps kept for drawings.
 *
 * Snapshots of the whole array rather than a diff: a chart carries tens of
 * drawings, not thousands, so the simple thing is also the cheap thing.
 */
const HISTORY_LIMIT = 50

/** Where the workspace is saved, in localStorage. */
const WORKSPACE_STORAGE_KEY = 'mrl.workspace'

interface WorkspaceState {
  // ---- what is charted ------------------------------------------------
  primarySymbol: SymbolKey
  /** Correlated charts shown alongside the primary, for SMT comparison. */
  compareSymbols: SymbolKey[]
  interval: Interval
  /**
   * The timeframe a higher-timeframe bias is read from.
   *
   * A workspace setting rather than one of the detector filters, because it
   * names a *view* the way `interval` does -- "the 4-hour behind this
   * 5-minute" -- and stays put while conditions are switched on and off.
   * Only sent with a run that actually asks for the bias.
   */
  higherTimeframe: Interval
  rangeDays: RangeDays
  /**
   * Intervals pinned to the top bar.
   *
   * The full list is thirteen long, which is more than a toolbar can hold and
   * more than an eye can scan. Everything stays reachable from the menu; this
   * is only which ones are one click away.
   */
  favouriteIntervals: Interval[]
  /** Which of the three links between the charts are live. */
  chartSync: ChartSync
  /**
   * Per-market intervals, used only while the interval link is off.
   *
   * Kept rather than discarded when the link is switched back on, so turning
   * it off again returns each pane to the bar size it was on instead of
   * making the arrangement something you have to rebuild every time.
   */
  intervalOverrides: Partial<Record<SymbolKey, Interval>>

  // ---- layout ---------------------------------------------------------
  /** Which side panel is docked, or `null` when the column is closed. */
  sidePanel: SidePanel | null
  resultsOpen: boolean
  /** Fraction of the row the charts take, against the side panel. */
  sidebarRatio: number
  /** Fraction of the column the charts take, against the results. */
  chartRatio: number
  /** How the charted markets are arranged against each other. */
  chartLayout: ChartLayout
  /** The clock every timestamp in the app is drawn against. */
  timeZone: TimeZoneId
  /**
   * Where the primary instrument trades. Not persisted and not chosen: it
   * comes from the symbol list, and only matters when `timeZone` is
   * `exchange`.
   */
  exchangeZone: string

  // ---- analysis -------------------------------------------------------
  ict: IctSettings

  // ---- drawing --------------------------------------------------------
  tool: ToolMode
  drawingColor: string
  drawingWidth: number
  /** Snap drawing points to the nearest open, high, low or close. */
  magnet: boolean
  chartSettings: ChartSettings
  /**
   * Everything but the candles, hidden at once.
   *
   * Deliberately an override rather than a state change: it does not write to
   * `sidePanel` or `resultsOpen`, so leaving focus restores exactly the
   * workspace you had rather than a default someone guessed at. Not persisted
   * either -- a full-screen chart is a thing you do for a minute, and coming
   * back tomorrow to an app that appears to have lost its panels is not.
   */
  focusMode: boolean
  drawings: Drawing[]
  selectedDrawingId: string | null
  snapToSwings: boolean
  /** Drawing snapshots either side of the present. Never persisted. */
  past: Drawing[][]
  future: Drawing[][]
  /**
   * The edit the newest undo step is still taking keystrokes for, if any.
   *
   * Typing into a note calls `updateDrawing` once per character, and each
   * call used to be its own step -- so a sentence of fifty-odd characters
   * pushed everything before it out of the fifty-step history, and undo
   * took the note back one letter at a time. While this names the note
   * being typed into, further keystrokes revise that one step instead.
   * Anything else that touches the history, or the selection, ends it.
   * Never persisted.
   */
  historyGroup: string | null

  // ---- backtest input -------------------------------------------------
  selection: SelectionRange | null
  /**
   * The stretch of history the engine searches. `null` means the whole
   * loaded range, which is what the lookback field describes.
   *
   * Kept apart from `selection`: that is the *shape* being looked for, this
   * is *where* to look for it. Narrowing the window never removes candles
   * from the chart -- bars outside it are drawn as usual and simply not
   * searched.
   */
  testWindow: TimeWindow | null
  rules: TradeRules
  search: SearchConfig
  detectors: DetectorFilters
  learning: LearningSettings
  strategy: StrategyKind
  gxt: GxtSettings
  /** Client-side only: the engine answers in percentages and sizes nothing. */
  sizing: SizingConfig

  // ---- results --------------------------------------------------------
  /** Which stored run the results panel is showing. Server state, so it is
   *  held by id and refetched rather than persisted. */
  activeBacktestId: string | null
  /**
   * Why the most recent run failed, or `null`. Not persisted.
   *
   * Held here rather than read off the mutation: that result belongs to the
   * component that started the run, and the Strategy panel is unmounted by
   * focus mode, by the Analysis tab and by collapsing the column -- any of
   * which, during a run that then failed, used to lose the message.
   */
  runError: string | null
  /** Paint the simulated trades over the candles they were taken on. */
  showTrades: boolean
  /** The trade the chart is highlighting, and whose evidence it may show. */
  selectedTradeId: string | null

  // ---- actions --------------------------------------------------------
  setPrimarySymbol: (symbol: SymbolKey) => void
  toggleCompareSymbol: (symbol: SymbolKey) => void
  setInterval: (interval: Interval) => void
  setHigherTimeframe: (interval: Interval) => void
  toggleFavouriteInterval: (interval: Interval) => void
  updateChartSync: (patch: Partial<ChartSync>) => void
  setSymbolInterval: (symbol: SymbolKey, interval: Interval) => void
  setSidePanel: (panel: SidePanel | null) => void
  setResultsOpen: (open: boolean) => void
  setSidebarRatio: (ratio: number) => void
  setChartRatio: (ratio: number) => void
  setRangeDays: (days: RangeDays) => void
  setChartLayout: (layout: ChartLayout) => void
  setTimeZone: (zone: TimeZoneId) => void
  setExchangeZone: (zone: string) => void

  updateIct: (patch: Partial<IctSettings>) => void

  setTool: (tool: ToolMode) => void
  setDrawingColor: (color: string) => void
  setDrawingWidth: (width: number) => void
  toggleMagnet: () => void
  updateChartSettings: (patch: Partial<ChartSettings>) => void
  toggleFocusMode: () => void
  addDrawing: (drawing: Drawing) => void
  updateDrawing: (id: string, patch: Partial<Drawing>) => void
  removeDrawing: (id: string) => void
  /** Remove the drawings on these markets, or on every market when none are named. */
  clearDrawings: (symbols?: string[]) => void
  selectDrawing: (id: string | null) => void
  setSnapToSwings: (snap: boolean) => void
  undoDrawings: () => void
  redoDrawings: () => void

  setSelection: (selection: SelectionRange | null) => void
  setTestWindow: (window: TimeWindow | null) => void
  updateRules: (patch: Partial<TradeRules>) => void
  updateSearch: (patch: Partial<SearchConfig>) => void
  updateDetectors: (patch: Partial<DetectorFilters>) => void
  updateLearning: (patch: Partial<LearningSettings>) => void
  setStrategy: (strategy: StrategyKind) => void
  updateGxt: (patch: Partial<GxtSettings>) => void
  updateSizing: (patch: Partial<SizingConfig>) => void
  resetStrategy: () => void
  setActiveBacktestId: (id: string | null) => void
  setRunError: (message: string | null) => void
  setShowTrades: (show: boolean) => void
  selectTrade: (id: string | null) => void
}

/**
 * Replace the drawings and record the step.
 *
 * Every mutation goes through here so that undo covers all of them uniformly,
 * and so that a drag produces exactly one step: the canvas previews the move
 * locally and only calls the store once, on release.
 */
function commitDrawings(
  state: Pick<WorkspaceState, 'drawings' | 'past'>,
  drawings: Drawing[],
): Pick<WorkspaceState, 'drawings' | 'past' | 'future' | 'historyGroup'> {
  return {
    drawings,
    past: [...state.past, state.drawings].slice(-HISTORY_LIMIT),
    // Any new edit abandons the branch that redo would have gone down.
    future: [],
    // And ends a run of keystrokes: typing after it is a new step.
    historyGroup: null,
  }
}

/**
 * The run of edits a patch continues, or `null` for one that stands alone.
 *
 * Only the text of a note: it is the one field changed a character at a
 * time. A colour, a width or a drag is a single decision and keeps its own
 * step.
 */
function editGroup(id: string, patch: Partial<Drawing>): string | null {
  const keys = Object.keys(patch)
  return keys.length === 1 && keys[0] === 'text' ? `text:${id}` : null
}

/** Keep the selection only if the drawing still exists in the restored set. */
function keepSelection(drawings: Drawing[], selectedId: string | null): string | null {
  return drawings.some((drawing) => drawing.id === selectedId) ? selectedId : null
}

/**
 * Keep the selection only if its drawing is on a market still charted.
 *
 * A drawing stays selected across a change of market, and Delete acts on
 * whatever is selected: switch the primary from NQ to YM with an NQ line
 * picked and NQ off screen, and the next Delete -- or a Backspace meant for
 * something else -- removed a line nobody could see.
 */
function keepChartedSelection(
  state: Pick<WorkspaceState, 'drawings' | 'selectedDrawingId'>,
  charted: string[],
): string | null {
  const selected = state.drawings.find((drawing) => drawing.id === state.selectedDrawingId)
  return selected && charted.includes(selected.symbol) ? selected.id : null
}

type IntervalState = Pick<
  WorkspaceState,
  'interval' | 'chartSync' | 'intervalOverrides' | 'primarySymbol'
>

/**
 * The bar size one pane is drawn at: the shared interval while the link is
 * live, otherwise the pane's own, falling back to the shared one for a pane
 * never set individually. The rule `useSymbolInterval` answers with.
 */
export function paneIntervalOf(state: IntervalState, symbol: SymbolKey): Interval {
  return state.chartSync.interval
    ? state.interval
    : (state.intervalOverrides[symbol] ?? state.interval)
}

/**
 * The bar size of the primary pane -- the one a setup is selected on and a
 * backtest runs at, which is not the toolbar's interval once the link is off.
 */
export function primaryIntervalOf(state: IntervalState): Interval {
  return paneIntervalOf(state, state.primarySymbol)
}

/**
 * Apply a change, and bring along what hangs off the primary pane's interval
 * if the change moved it.
 *
 * Three things do: the selection, which names a run of candles at one bar
 * size and is meaningless at another; the bias timeframe, which has to be
 * made of whole primary bars; and the bias switch, which cannot stay on
 * where nothing above the interval exists. The primary's interval moves when
 * the shared interval changes while it follows that, when its own changes
 * while the link is off, when the link is switched, and when another market
 * becomes primary. A change that leaves it where it was touches none of the
 * three -- so moving the shared interval while the primary keeps its own no
 * longer throws away a setup drawn on a chart that did not change.
 */
function followPrimaryInterval(
  state: WorkspaceState,
  next: Partial<WorkspaceState>,
): Partial<WorkspaceState> {
  const after = primaryIntervalOf({ ...state, ...next })
  if (after === primaryIntervalOf(state)) return next
  const detectors = next.detectors ?? state.detectors
  return {
    ...next,
    higherTimeframe: coarserOf(next.higherTimeframe ?? state.higherTimeframe, after),
    detectors: canReadBias(after)
      ? detectors
      : { ...detectors, require_higher_timeframe_bias: false },
    selection: null,
  }
}

/**
 * Bring a stored workspace up to the current shape.
 *
 * Exported so it can be tested directly. A migration only ever runs against
 * state someone else saved -- by definition never against a fresh install --
 * so a mistake here is invisible to whoever wrote it, and surfaces as the app
 * coming back subtly wrong for everyone who used the previous version.
 */
export function migrateWorkspace(persisted: unknown, version: number) {
  const state = persisted as
    | {
        ict?: IctSettings
        detectors?: DetectorFilters
        chartSync?: ChartSync
        interval?: Interval
        rangeDays?: RangeDays
      }
    | undefined
  if (!state) return state

  /*
   * A stored range outlives the rule that bounds it.
   *
   * The clamp lives in `setInterval`/`setRangeDays`, which a rehydrate never
   * calls -- so a workspace saved as 5m over 180 days came back exactly as
   * saved and every chart showed the bar-count error the clamp exists to
   * prevent. Anyone who hit that combination before upgrading would be stuck
   * in it, since the way out is to press the interval button that was
   * already selected.
   */
  const clamped =
    state.interval && state.rangeDays
      ? {
          ...state,
          rangeDays: Math.min(state.rangeDays, longestRange(state.interval)),
        }
      : state

  /*
   * Merged under the stored settings, so a key that has always existed keeps
   * the user's answer and only a genuinely new one takes the default.
   *
   * Both objects, not just `ict`. Zustand's merge is shallow, so a persisted
   * object replaces its default wholesale rather than being merged into it --
   * which means every persisted *object* has this hazard, and picking one of
   * them to backfill fixes half the problem. A missing boolean reaches a
   * switch as `undefined`, and `undefined` is dropped by `JSON.stringify`, so
   * the gap survives every reload until the control is clicked.
   */
  const filled = {
    ...clamped,
    ict: { ...DEFAULT_ICT_SETTINGS, ...state.ict },
    detectors: { ...DEFAULT_DETECTOR_FILTERS, ...state.detectors },
    chartSync: { ...DEFAULT_CHART_SYNC, ...state.chartSync },
  }

  /*
   * The scroll, the zoom and the crosshair are unlinked once, on the way in.
   *
   * Same argument as the overlays above, and the same trap: these three were
   * saved as `true` by every version that existed before the default moved,
   * so leaving them alone would mean the one person who has actually been
   * using the app is the one person who never sees the change. Panning NQ
   * would still drag ES along, and the fix would look like it had not
   * landed.
   *
   * Forced rather than merely defaulted, and only for the switches that
   * moved -- `interval` keeps whatever was chosen. Linking the panes back up
   * afterwards sticks, because by then it is an answer rather than a
   * leftover.
   */
  const unlinked =
    version >= 4
      ? filled
      : {
          ...filled,
          chartSync: { ...filled.chartSync, crosshair: false, time: false },
        }

  if (version >= 2) return unlinked
  return {
    ...unlinked,
    ict: {
      ...unlinked.ict,
      showSwings: false,
      showGaps: false,
      showSmt: false,
      showTradeEvidence: true,
    },
  }
}

/** Drawings read back from storage, with what an older build left out filled in. */
function repairDrawings(drawings: Drawing[]): Drawing[] {
  return drawings.map((drawing) => ({
    ...drawing,
    // A canvas handed `NaN` for a line width ignores it and strokes with
    // whatever the previous shape left behind.
    width: Number.isFinite(drawing.width) ? drawing.width : DEFAULT_DRAWING_WIDTH,
  }))
}

/**
 * Lay a stored workspace over the defaults, on every load.
 *
 * `migrate` only runs when the stored version differs from the current one,
 * and a stored object replaces its default whole. So a field added without a
 * version bump never reached anyone who had saved before it: the eight
 * detector settings that arrived after version 4 came back `undefined` for
 * every workspace saved by the version-4 build, and the Strategy panel threw
 * on the first of them (`detectors.sessions.length`) and took the whole app
 * down -- on every load, since nothing could then write the object back.
 * `learning` had never been filled at all, and drawings from before stroke
 * widths existed had none. Running here instead of in `migrate` makes the
 * fill unconditional, so the next field added cannot repeat it.
 *
 * Settings that only make sense together are repaired too, because a stored
 * pair outlives the rule between them: an interval and the history it can
 * carry, an interval and a bias timeframe made of whole bars of it -- a 90m
 * bias saved against 1h before that rule existed read "90m" in the panel
 * while every run quietly used 4h -- and a bias switch left on where there
 * is no higher timeframe to read.
 *
 * Exported so it can be tested directly.
 */
export function mergeWorkspace(
  persisted: unknown,
  current: WorkspaceState,
): WorkspaceState {
  if (persisted == null || typeof persisted !== 'object') return current
  const saved = persisted as Partial<WorkspaceState>

  const merged: WorkspaceState = {
    ...current,
    ...saved,
    // An interval the list no longer has would reach every range and cap
    // lookup as `undefined`.
    interval: INTERVALS.includes(saved.interval as Interval)
      ? (saved.interval as Interval)
      : current.interval,
    ict: { ...DEFAULT_ICT_SETTINGS, ...saved.ict },
    detectors: { ...DEFAULT_DETECTOR_FILTERS, ...saved.detectors },
    rules: { ...DEFAULT_TRADE_RULES, ...saved.rules },
    search: { ...DEFAULT_SEARCH_CONFIG, ...saved.search },
    learning: { ...DEFAULT_LEARNING_SETTINGS, ...saved.learning },
    sizing: { ...DEFAULT_SIZING, ...saved.sizing },
    chartSettings: { ...DEFAULT_CHART_SETTINGS, ...saved.chartSettings },
    chartSync: { ...DEFAULT_CHART_SYNC, ...saved.chartSync },
    drawings: Array.isArray(saved.drawings) ? repairDrawings(saved.drawings) : current.drawings,
  }

  const primary = primaryIntervalOf(merged)
  return {
    ...merged,
    rangeDays: Math.min(merged.rangeDays, longestRange(merged.interval)) as RangeDays,
    higherTimeframe: coarserOf(merged.higherTimeframe, primary),
    detectors: canReadBias(primary)
      ? merged.detectors
      : { ...merged.detectors, require_higher_timeframe_bias: false },
  }
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      primarySymbol: 'NQ',
      compareSymbols: ['ES'],
      interval: '1h',
      higherTimeframe: '4h',
      rangeDays: 180,
      favouriteIntervals: DEFAULT_FAVOURITE_INTERVALS,
      chartSync: DEFAULT_CHART_SYNC,
      intervalOverrides: {},

      sidePanel: 'strategy',
      resultsOpen: true,
      sidebarRatio: 0.78,
      chartRatio: 0.58,
      chartLayout: 'stacked',
      timeZone: EXCHANGE_TIME_ZONE,
      exchangeZone: DEFAULT_EXCHANGE_ZONE,

      ict: DEFAULT_ICT_SETTINGS,

      tool: 'cursor',
      drawingColor: DEFAULT_DRAWING_COLOR,
      drawingWidth: DEFAULT_DRAWING_WIDTH,
      magnet: true,
      chartSettings: DEFAULT_CHART_SETTINGS,
      focusMode: false,
      drawings: [],
      selectedDrawingId: null,
      snapToSwings: true,
      past: [],
      future: [],
      historyGroup: null,

      selection: null,
      testWindow: null,
      rules: DEFAULT_TRADE_RULES,
      search: DEFAULT_SEARCH_CONFIG,
      detectors: DEFAULT_DETECTOR_FILTERS,
      learning: DEFAULT_LEARNING_SETTINGS,
      strategy: 'pattern',
      gxt: DEFAULT_GXT_SETTINGS,
      sizing: DEFAULT_SIZING,
      activeBacktestId: null,
      runError: null,
      showTrades: true,
      selectedTradeId: null,

      setPrimarySymbol: (symbol) =>
        set((state) => {
          // Pressing the market that is already primary changes nothing, so
          // it must not cost the setup drawn on it either.
          if (symbol === state.primarySymbol) return state
          // Keep the new primary out of the comparison row so it is not
          // charted twice, and never compare a symbol against itself.
          const compareSymbols = state.compareSymbols.filter((item) => item !== symbol)
          return {
            ...followPrimaryInterval(state, { primarySymbol: symbol, compareSymbols }),
            // A selection is a range of candles on one instrument; carrying it
            // across to a different instrument would silently retarget the test.
            selection: null,
            // The results on screen were computed for the old instrument.
            selectedTradeId: null,
            selectedDrawingId: keepChartedSelection(state, [symbol, ...compareSymbols]),
          }
        }),

      toggleCompareSymbol: (symbol) =>
        set((state) => {
          if (symbol === state.primarySymbol) return state
          const active = state.compareSymbols.includes(symbol)
          const compareSymbols = active
            ? state.compareSymbols.filter((item) => item !== symbol)
            : [...state.compareSymbols, symbol]
          return {
            compareSymbols,
            selectedDrawingId: keepChartedSelection(state, [
              state.primarySymbol,
              ...compareSymbols,
            ]),
          }
        }),

      /*
       * Kept strictly coarser than the entry interval, because the backend
       * refuses a run where it is not -- a "1h bias" on a 1h backtest is the
       * same structure consulted twice. Nudged up rather than refused here:
       * dropping to the daily should not make you go and fix a second
       * setting before the button works again.
       *
       * The entry interval is the primary pane's, which is the one a run is
       * made at. Measured against the toolbar's instead, a 15m bias for a 5m
       * primary under a 1h toolbar was "corrected" to 4h.
       */
      setHigherTimeframe: (higherTimeframe) =>
        set((state) => ({
          higherTimeframe: coarserOf(higherTimeframe, primaryIntervalOf(state)),
        })),

      setInterval: (interval) =>
        set((state) => {
          // Pressing the interval already selected changes nothing, so it
          // must not throw away the setup drawn on it either.
          if (interval === state.interval) return state
          /*
           * The bias timeframe is carried up with the entry interval when it
           * would otherwise be left at or below it, and the selection is
           * dropped -- the same wall-clock range is a different number of
           * candles on a different interval, so the pattern would no longer
           * be the one picked. Both only when the primary pane is the one
           * that moved: with the link off and the primary on its own
           * interval, its setup is untouched. The test window is wall-clock
           * either way, so it survives: "test August" means the same thing
           * at any resolution.
           */
          return followPrimaryInterval(state, {
            interval,
            // A finer interval cannot hold as much history, so the range comes
            // down with it rather than being left somewhere the backend will
            // refuse. Visibly: the preset that ends up selected is the one that
            // loaded, never a silent substitution for the one that was pressed.
            rangeDays: Math.min(state.rangeDays, longestRange(interval)) as RangeDays,
          })
        }),

      /**
       * Pin or unpin an interval, keeping the row in the canonical order.
       *
       * Sorted rather than appended so the row reads finest-to-coarsest
       * however it was built up -- a toolbar whose buttons are in the order
       * they happened to be pressed is one you have to read every time.
       * The last favourite cannot be removed: an empty row would leave the
       * current interval with nothing showing it is selected.
       */
      toggleFavouriteInterval: (interval) =>
        set((state) => {
          const pinned = state.favouriteIntervals.includes(interval)
          if (pinned && state.favouriteIntervals.length === 1) return state
          const next = pinned
            ? state.favouriteIntervals.filter((item) => item !== interval)
            : [...state.favouriteIntervals, interval]
          return {
            favouriteIntervals: INTERVALS.filter((item) => next.includes(item)),
          }
        }),

      updateChartSync: (patch) =>
        set((state) => {
          const chartSync = { ...state.chartSync, ...patch }
          // The broadcasts read a module variable rather than the store, so
          // it has to move in the same breath as the state -- the same
          // arrangement, and the same reason, as the time zone below.
          setSyncModes(chartSync)
          // Switching the interval link moves the primary pane between the
          // shared interval and its own, which redraws its setup on bars it
          // was not drawn on unless the setup goes with it.
          return followPrimaryInterval(state, { chartSync })
        }),

      setSymbolInterval: (symbol, interval) =>
        set((state) =>
          // A selection names a run of candles on one interval, so it cannot
          // survive that interval changing under the primary chart -- and only
          // that: a comparison pane, or the primary's own setting while the
          // link holds every pane to the shared interval, leaves it alone.
          followPrimaryInterval(state, {
            intervalOverrides: { ...state.intervalOverrides, [symbol]: interval },
          }),
        ),

      setRangeDays: (rangeDays) =>
        set((state) => ({
          rangeDays: Math.min(rangeDays, longestRange(state.interval)) as RangeDays,
        })),

      setChartLayout: (chartLayout) => set({ chartLayout }),

      // Layout is a working preference, not session state: a workspace closed
      // down to the candles should still be closed down to the candles after
      // a reload, or the panel you dismissed is back every morning.
      setSidePanel: (sidePanel) => set({ sidePanel }),
      setResultsOpen: (resultsOpen) => set({ resultsOpen }),
      setSidebarRatio: (sidebarRatio) => set({ sidebarRatio }),
      setChartRatio: (chartRatio) => set({ chartRatio }),

      setTimeZone: (timeZone) =>
        set((state) => {
          // The formatters read a module variable rather than the store, so it
          // has to move in the same breath as the state components watch.
          setFormattingTimeZone(resolveTimeZone(timeZone, state.exchangeZone))
          return { timeZone }
        }),

      setExchangeZone: (exchangeZone) =>
        set((state) => {
          if (exchangeZone === state.exchangeZone) return state
          setFormattingTimeZone(resolveTimeZone(state.timeZone, exchangeZone))
          return { exchangeZone }
        }),

      updateIct: (patch) => set((state) => ({ ict: { ...state.ict, ...patch } })),

      setTool: (tool) =>
        set((state) => ({
          tool,
          // Picking up a drawing tool means the next thing you do is make a
          // new shape, so an old selection stops being relevant. Coming back
          // to the cursor keeps it -- and what is selected then is usually
          // the shape just drawn, which is exactly what you want to adjust.
          selectedDrawingId: tool === 'cursor' ? state.selectedDrawingId : null,
          historyGroup: null,
        })),
      setDrawingColor: (drawingColor) => set({ drawingColor }),
      setDrawingWidth: (drawingWidth) => set({ drawingWidth }),
      toggleMagnet: () => set((state) => ({ magnet: !state.magnet })),
      updateChartSettings: (patch) =>
        set((state) => ({ chartSettings: { ...state.chartSettings, ...patch } })),
      toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),

      addDrawing: (drawing) =>
        set((state) => ({
          ...commitDrawings(state, [...state.drawings, drawing]),
          selectedDrawingId: drawing.id,
        })),

      updateDrawing: (id, patch) =>
        set((state) => {
          const drawings = state.drawings.map((drawing) =>
            drawing.id === id ? ({ ...drawing, ...patch } as Drawing) : drawing,
          )
          const group = editGroup(id, patch)
          // A further keystroke in the note already being typed: the step on
          // the stack is the one from before its first character, which is
          // where undo should go back to, so revise the present instead of
          // stacking another.
          if (group != null && group === state.historyGroup) {
            return { drawings, future: [] }
          }
          return { ...commitDrawings(state, drawings), historyGroup: group }
        }),

      removeDrawing: (id) =>
        set((state) => ({
          ...commitDrawings(
            state,
            state.drawings.filter((drawing) => drawing.id !== id),
          ),
          selectedDrawingId:
            state.selectedDrawingId === id ? null : state.selectedDrawingId,
        })),

      clearDrawings: (symbols) =>
        set((state) => ({
          ...commitDrawings(
            state,
            symbols
              ? state.drawings.filter((drawing) => !symbols.includes(drawing.symbol))
              : [],
          ),
          selectedDrawingId: null,
        })),

      // Picking a drawing, even the same one again, starts a new edit: coming
      // back to a note later and typing is a second decision, with a step of
      // its own.
      selectDrawing: (selectedDrawingId) => set({ selectedDrawingId, historyGroup: null }),
      setSnapToSwings: (snapToSwings) => set({ snapToSwings }),

      undoDrawings: () =>
        set((state) => {
          const previous = state.past.at(-1)
          if (!previous) return state
          return {
            drawings: previous,
            past: state.past.slice(0, -1),
            future: [state.drawings, ...state.future].slice(0, HISTORY_LIMIT),
            selectedDrawingId: keepSelection(previous, state.selectedDrawingId),
            historyGroup: null,
          }
        }),

      redoDrawings: () =>
        set((state) => {
          const next = state.future[0]
          if (!next) return state
          return {
            drawings: next,
            past: [...state.past, state.drawings].slice(-HISTORY_LIMIT),
            future: state.future.slice(1),
            selectedDrawingId: keepSelection(next, state.selectedDrawingId),
            historyGroup: null,
          }
        }),

      setSelection: (selection) => set({ selection }),

      setTestWindow: (testWindow) =>
        set(
          testWindow == null
            ? { testWindow: null }
            : {
                // Stored low-to-high so that everything downstream can treat
                // it as a range without re-checking which end was dragged.
                testWindow: {
                  start_time: Math.min(testWindow.start_time, testWindow.end_time),
                  end_time: Math.max(testWindow.start_time, testWindow.end_time),
                },
              },
        ),

      updateRules: (patch) => set((state) => ({ rules: { ...state.rules, ...patch } })),
      updateSearch: (patch) => set((state) => ({ search: { ...state.search, ...patch } })),
      updateDetectors: (patch) =>
        set((state) => ({ detectors: { ...state.detectors, ...patch } })),
      updateLearning: (patch) =>
        set((state) => ({ learning: { ...state.learning, ...patch } })),
      setStrategy: (strategy) => set({ strategy, activeBacktestId: null, selectedTradeId: null }),
      updateGxt: (patch) => set((state) => ({ gxt: { ...state.gxt, ...patch } })),
      updateSizing: (patch) => set((state) => ({ sizing: { ...state.sizing, ...patch } })),

      resetStrategy: () =>
        set({
          rules: DEFAULT_TRADE_RULES,
          search: DEFAULT_SEARCH_CONFIG,
          detectors: DEFAULT_DETECTOR_FILTERS,
          learning: DEFAULT_LEARNING_SETTINGS,
          strategy: 'pattern',
          gxt: DEFAULT_GXT_SETTINGS,
        }),

      setActiveBacktestId: (activeBacktestId) =>
        // A trade id belongs to the run it came from, so it cannot survive a
        // change of run.
        set({ activeBacktestId, selectedTradeId: null }),
      setRunError: (runError) => set({ runError }),

      setShowTrades: (showTrades) => set({ showTrades }),
      selectTrade: (selectedTradeId) => set({ selectedTradeId }),
    }),
    {
      name: WORKSPACE_STORAGE_KEY,
      version: 5,
      /**
       * Version 2 turns the ICT overlays off.
       *
       * A stored preference outlives a change of default, so anyone who has
       * opened the app before would keep the crowded chart forever and never
       * learn that the default had moved. The flags are reset once, on the
       * first load after the upgrade; turning them back on afterwards sticks,
       * because by then it is a choice rather than a leftover.
       *
       * Version 3 backfills the liquidity settings.
       *
       * A stored `ict` object is restored whole, so one written before those
       * fields existed comes back without them -- and a number field handed
       * `undefined` is an uncontrolled input showing nothing, on the two
       * settings that decide what counts as a level. Defaults are merged
       * *under* what was stored, so every earlier choice survives and only
       * the genuinely absent keys are filled.
       *
       * Version 4 unlinks the scroll, the zoom and the crosshair, so that
       * moving one chart stops moving the rest. `chartSync` joins the two
       * objects above in being backfilled, for the same reason they are: it
       * is restored whole, so one saved before a switch existed comes back
       * without it.
       *
       * Version 5 repeats that backfill, for every stored object, in `merge`,
       * which runs on every load rather than only on a change of version --
       * see `mergeWorkspace` for the crash that came from relying on this
       * alone. Nothing about the stored shape changed; the bump only marks
       * where that began.
       */
      migrate: migrateWorkspace,
      merge: mergeWorkspace,
      // The transient bits of a session: which tool is held, what is selected,
      // the pending range, and the undo stack. Restoring these would be
      // confusing on reload -- undoing into a shape from yesterday most of
      // all, since there would be no gesture on screen to explain it.
      //
      // The test window is transient for a sharper reason: it names a stretch
      // of wall-clock history, and one restored from last week would quietly
      // narrow a run to a period the user is no longer looking at.
      partialize: (state) => ({
        primarySymbol: state.primarySymbol,
        compareSymbols: state.compareSymbols,
        interval: state.interval,
        higherTimeframe: state.higherTimeframe,
        rangeDays: state.rangeDays,
        favouriteIntervals: state.favouriteIntervals,
        chartSync: state.chartSync,
        intervalOverrides: state.intervalOverrides,
        chartLayout: state.chartLayout,
        sidePanel: state.sidePanel,
        resultsOpen: state.resultsOpen,
        sidebarRatio: state.sidebarRatio,
        chartRatio: state.chartRatio,
        timeZone: state.timeZone,
        ict: state.ict,
        drawings: state.drawings,
        drawingColor: state.drawingColor,
        drawingWidth: state.drawingWidth,
        magnet: state.magnet,
        chartSettings: state.chartSettings,
        snapToSwings: state.snapToSwings,
        rules: state.rules,
        search: state.search,
        detectors: state.detectors,
        learning: state.learning,
        strategy: state.strategy,
        gxt: state.gxt,
        sizing: state.sizing,
        showTrades: state.showTrades,
      }),
    },
  ),
)

// `persist` rehydrates as this module is evaluated, so the restored zone has
// to reach the formatters before anything renders. A zone that has since left
// the list -- or a hand-edited one -- falls back to the machine clock rather
// than throwing inside `Intl` on every timestamp.
if (!isKnownTimeZone(useWorkspace.getState().timeZone)) {
  useWorkspace.setState({ timeZone: EXCHANGE_TIME_ZONE })
}
setFormattingTimeZone(
  resolveTimeZone(useWorkspace.getState().timeZone, useWorkspace.getState().exchangeZone),
)

/*
 * Drawings saved by another tab of the app.
 *
 * Each tab holds the workspace in memory and writes the whole of it on every
 * change, so with two tabs open one tab's drawings were overwritten by the
 * other's next edit -- a level drawn on the left monitor gone the moment a
 * line was moved on the right. Another tab's save is taken up here, drawings
 * only: which market and interval each tab shows is that tab's own business.
 * Drawings equal to these are left alone, so two tabs answering each other's
 * saves settle after one round instead of trading writes for ever. The undo
 * history goes with them: it described drawings this tab no longer has.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== WORKSPACE_STORAGE_KEY || !event.newValue) return
    let saved: unknown
    try {
      saved = JSON.parse(event.newValue)?.state?.drawings
    } catch {
      return
    }
    if (!Array.isArray(saved)) return
    const current = useWorkspace.getState()
    if (JSON.stringify(saved) === JSON.stringify(current.drawings)) return
    const drawings = repairDrawings(saved as Drawing[])
    useWorkspace.setState({
      drawings,
      selectedDrawingId: keepSelection(drawings, current.selectedDrawingId),
      past: [],
      future: [],
      historyGroup: null,
    })
  })
}

// Same argument for the sync links: they are read from a module variable on a
// path that runs on every mouse move, so a restored setting has to reach it
// before the first crosshair event rather than on the next toggle.
setSyncModes(useWorkspace.getState().chartSync)

/**
 * Subscribe to the active time zone, already resolved to an IANA name.
 *
 * Components that print timestamps call this even where they ignore the value:
 * the formatters read a module variable, so without a store subscription a
 * change of zone would leave yesterday's labels on screen until something else
 * happened to re-render them.
 */
export function useTimeZone(): string {
  const zone = useWorkspace((state) => state.timeZone)
  const exchangeZone = useWorkspace((state) => state.exchangeZone)
  return resolveTimeZone(zone, exchangeZone)
}

/**
 * The interval one pane is on.
 *
 * With the interval link live every pane answers with the shared one, which
 * is what makes switching timeframe a single decision. With it off each
 * market keeps its own -- structure on the weekly, entries on the 3-minute --
 * falling back to the shared interval for any pane never set individually.
 */
export function useSymbolInterval(symbol: SymbolKey): Interval {
  return useWorkspace((state) => paneIntervalOf(state, symbol))
}

/** Every symbol the workspace currently charts, primary first. */
export function useChartedSymbols(): SymbolKey[] {
  const primary = useWorkspace((state) => state.primarySymbol)
  const compare = useWorkspace((state) => state.compareSymbols)
  return [primary, ...compare.filter((symbol) => symbol !== primary)]
}
