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
  type Drawing,
  type ToolMode,
} from '@/types/drawing'
import { DEFAULT_ICT_SETTINGS, type IctSettings } from '@/types/ict'
import {
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_SIZING,
  DEFAULT_TRADE_RULES,
  type SearchConfig,
  type SizingConfig,
  type TradeRules,
} from '@/types/backtest'
import type { Interval, SelectionRange, SymbolKey, TimeWindow } from '@/types/market'

/** History loaded into the chart, in days. */
export const RANGE_PRESETS = [30, 60, 90, 180, 365, 730] as const
export type RangeDays = (typeof RANGE_PRESETS)[number]

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

interface WorkspaceState {
  // ---- what is charted ------------------------------------------------
  primarySymbol: SymbolKey
  /** Correlated charts shown alongside the primary, for SMT comparison. */
  compareSymbols: SymbolKey[]
  interval: Interval
  rangeDays: RangeDays
  /** How the charted markets are arranged against each other. */
  chartLayout: ChartLayout

  // ---- analysis -------------------------------------------------------
  ict: IctSettings

  // ---- drawing --------------------------------------------------------
  tool: ToolMode
  drawingColor: string
  drawings: Drawing[]
  selectedDrawingId: string | null
  snapToSwings: boolean
  /** Drawing snapshots either side of the present. Never persisted. */
  past: Drawing[][]
  future: Drawing[][]

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
  /** Client-side only: the engine answers in percentages and sizes nothing. */
  sizing: SizingConfig

  // ---- results --------------------------------------------------------
  /** Which stored run the results panel is showing. Server state, so it is
   *  held by id and refetched rather than persisted. */
  activeBacktestId: string | null
  /** Paint the simulated trades over the candles they were taken on. */
  showTrades: boolean
  /** The trade the chart is highlighting, and whose evidence it may show. */
  selectedTradeId: string | null

  // ---- actions --------------------------------------------------------
  setPrimarySymbol: (symbol: SymbolKey) => void
  toggleCompareSymbol: (symbol: SymbolKey) => void
  setInterval: (interval: Interval) => void
  setRangeDays: (days: RangeDays) => void
  setChartLayout: (layout: ChartLayout) => void

  updateIct: (patch: Partial<IctSettings>) => void

  setTool: (tool: ToolMode) => void
  setDrawingColor: (color: string) => void
  addDrawing: (drawing: Drawing) => void
  updateDrawing: (id: string, patch: Partial<Drawing>) => void
  removeDrawing: (id: string) => void
  clearDrawings: (symbol?: string) => void
  selectDrawing: (id: string | null) => void
  setSnapToSwings: (snap: boolean) => void
  undoDrawings: () => void
  redoDrawings: () => void

  setSelection: (selection: SelectionRange | null) => void
  setTestWindow: (window: TimeWindow | null) => void
  updateRules: (patch: Partial<TradeRules>) => void
  updateSearch: (patch: Partial<SearchConfig>) => void
  updateSizing: (patch: Partial<SizingConfig>) => void
  resetStrategy: () => void
  setActiveBacktestId: (id: string | null) => void
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
): Pick<WorkspaceState, 'drawings' | 'past' | 'future'> {
  return {
    drawings,
    past: [...state.past, state.drawings].slice(-HISTORY_LIMIT),
    // Any new edit abandons the branch that redo would have gone down.
    future: [],
  }
}

/** Keep the selection only if the drawing still exists in the restored set. */
function keepSelection(drawings: Drawing[], selectedId: string | null): string | null {
  return drawings.some((drawing) => drawing.id === selectedId) ? selectedId : null
}

export const useWorkspace = create<WorkspaceState>()(
  persist(
    (set) => ({
      primarySymbol: 'NQ',
      compareSymbols: ['ES'],
      interval: '1h',
      rangeDays: 180,
      chartLayout: 'stacked',

      ict: DEFAULT_ICT_SETTINGS,

      tool: 'cursor',
      drawingColor: DEFAULT_DRAWING_COLOR,
      drawings: [],
      selectedDrawingId: null,
      snapToSwings: true,
      past: [],
      future: [],

      selection: null,
      testWindow: null,
      rules: DEFAULT_TRADE_RULES,
      search: DEFAULT_SEARCH_CONFIG,
      sizing: DEFAULT_SIZING,
      activeBacktestId: null,
      showTrades: true,
      selectedTradeId: null,

      setPrimarySymbol: (symbol) =>
        set((state) => ({
          primarySymbol: symbol,
          // Keep the new primary out of the comparison row so it is not
          // charted twice, and never compare a symbol against itself.
          compareSymbols: state.compareSymbols.filter((item) => item !== symbol),
          // A selection is a range of candles on one instrument; carrying it
          // across to a different instrument would silently retarget the test.
          selection: null,
          // The results on screen were computed for the old instrument.
          selectedTradeId: null,
        })),

      toggleCompareSymbol: (symbol) =>
        set((state) => {
          if (symbol === state.primarySymbol) return state
          const active = state.compareSymbols.includes(symbol)
          return {
            compareSymbols: active
              ? state.compareSymbols.filter((item) => item !== symbol)
              : [...state.compareSymbols, symbol],
          }
        }),

      setInterval: (interval) =>
        set({
          interval,
          // The same wall-clock range means a different number of candles on a
          // different interval, so the pattern would no longer be the one the
          // user picked. The test window is wall-clock either way, so it
          // survives: "test August" means the same thing at any resolution.
          selection: null,
        }),

      setRangeDays: (rangeDays) => set({ rangeDays }),

      setChartLayout: (chartLayout) => set({ chartLayout }),

      updateIct: (patch) => set((state) => ({ ict: { ...state.ict, ...patch } })),

      setTool: (tool) =>
        set((state) => ({
          tool,
          // Picking up a drawing tool means the next thing you do is make a
          // new shape, so an old selection stops being relevant. Coming back
          // to the cursor keeps it -- and what is selected then is usually
          // the shape just drawn, which is exactly what you want to adjust.
          selectedDrawingId: tool === 'cursor' ? state.selectedDrawingId : null,
        })),
      setDrawingColor: (drawingColor) => set({ drawingColor }),

      addDrawing: (drawing) =>
        set((state) => ({
          ...commitDrawings(state, [...state.drawings, drawing]),
          selectedDrawingId: drawing.id,
        })),

      updateDrawing: (id, patch) =>
        set((state) =>
          commitDrawings(
            state,
            state.drawings.map((drawing) =>
              drawing.id === id ? ({ ...drawing, ...patch } as Drawing) : drawing,
            ),
          ),
        ),

      removeDrawing: (id) =>
        set((state) => ({
          ...commitDrawings(
            state,
            state.drawings.filter((drawing) => drawing.id !== id),
          ),
          selectedDrawingId:
            state.selectedDrawingId === id ? null : state.selectedDrawingId,
        })),

      clearDrawings: (symbol) =>
        set((state) => ({
          ...commitDrawings(
            state,
            symbol ? state.drawings.filter((drawing) => drawing.symbol !== symbol) : [],
          ),
          selectedDrawingId: null,
        })),

      selectDrawing: (selectedDrawingId) => set({ selectedDrawingId }),
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
      updateSizing: (patch) => set((state) => ({ sizing: { ...state.sizing, ...patch } })),

      resetStrategy: () =>
        set({ rules: DEFAULT_TRADE_RULES, search: DEFAULT_SEARCH_CONFIG }),

      setActiveBacktestId: (activeBacktestId) =>
        // A trade id belongs to the run it came from, so it cannot survive a
        // change of run.
        set({ activeBacktestId, selectedTradeId: null }),

      setShowTrades: (showTrades) => set({ showTrades }),
      selectTrade: (selectedTradeId) => set({ selectedTradeId }),
    }),
    {
      name: 'mrl.workspace',
      version: 2,
      /**
       * Version 2 turns the ICT overlays off.
       *
       * A stored preference outlives a change of default, so anyone who has
       * opened the app before would keep the crowded chart forever and never
       * learn that the default had moved. The flags are reset once, on the
       * first load after the upgrade; turning them back on afterwards sticks,
       * because by then it is a choice rather than a leftover.
       */
      migrate: (persisted, version) => {
        const state = persisted as { ict?: IctSettings } | undefined
        if (!state || version >= 2) return state
        return {
          ...state,
          ict: {
            ...DEFAULT_ICT_SETTINGS,
            ...state.ict,
            showSwings: false,
            showGaps: false,
            showSmt: false,
            showTradeEvidence: true,
          },
        }
      },
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
        rangeDays: state.rangeDays,
        chartLayout: state.chartLayout,
        ict: state.ict,
        drawings: state.drawings,
        drawingColor: state.drawingColor,
        snapToSwings: state.snapToSwings,
        rules: state.rules,
        search: state.search,
        sizing: state.sizing,
        showTrades: state.showTrades,
      }),
    },
  ),
)

/** Every symbol the workspace currently charts, primary first. */
export function useChartedSymbols(): SymbolKey[] {
  const primary = useWorkspace((state) => state.primarySymbol)
  const compare = useWorkspace((state) => state.compareSymbols)
  return [primary, ...compare.filter((symbol) => symbol !== primary)]
}
