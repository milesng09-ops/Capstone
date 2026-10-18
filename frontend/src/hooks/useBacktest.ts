/** React Query bindings for running and reloading backtests. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/services/api'
import { DEFAULT_DETECTOR_FILTERS, DEFAULT_LEARNING_SETTINGS, MAX_PATTERN_MATCHES } from '@/types/backtest'
import { canReadBias, coarserOf, useWorkspace } from '@/store/workspace'
import type {
  BacktestRequest,
  BacktestResult,
  DetectorFilters,
  LearningSettings,
  SearchConfig,
  TradeRules,
  GxtSettings,
} from '@/types/backtest'
import type { Interval, SelectionRange, TimeWindow } from '@/types/market'

const DAY_MS = 24 * 60 * 60 * 1000

export function buildGxtRequest(params: {
  primarySymbol: string
  symbols: string[]
  interval: Interval
  rules: TradeRules
  search: SearchConfig
  gxt: GxtSettings
  rangeEnd: number
  testWindow?: TimeWindow | null
}): BacktestRequest {
  const start = params.testWindow
    ? Math.min(params.testWindow.start_time, params.testWindow.end_time)
    : params.rangeEnd - params.search.lookbackDays * DAY_MS
  const end = params.testWindow
    ? Math.max(params.testWindow.start_time, params.testWindow.end_time)
    : params.rangeEnd
  const symbols = Array.from(new Set([params.primarySymbol, ...params.symbols]))
  return {
    strategy: 'gxt_research', gxt: params.gxt, symbols,
    primary_symbol: params.primarySymbol, interval: params.interval,
    higher_timeframe: null, // GXT builds its own complete 4H context.
    // Stored for compatibility/history grouping. GXT has no example selection.
    selection: { start_time: start, end_time: end },
    trade: { ...params.rules, entry_type: 'next_open' },
    search: {
      lookback_start: start, lookback_end: end, maximum_matches: params.search.maximumMatches,
      minimum_similarity: 0, pattern_length: null, minimum_separation_bars: null,
      search_symbols: [params.primarySymbol],
    },
    detectors: { ...DEFAULT_DETECTOR_FILTERS }, learning: { ...DEFAULT_LEARNING_SETTINGS },
  }
}

/**
 * The key every run is made under, so the running state can be read by
 * whichever component is on screen -- not only the one that pressed the
 * button, which the panel layout is free to unmount mid-run.
 */
export const RUN_BACKTEST_MUTATION_KEY = ['run-backtest'] as const

/**
 * The markets a run loads, and any added so an SMT condition can be met.
 *
 * SMT is a comparison: the engine reads the primary against a second market
 * and finds nothing at all without one. A description that names a single
 * market -- "long NQ after an SMT divergence" -- narrowed the request to NQ,
 * and every match was then dropped as "no confirmed SMT divergence", which
 * reads as a finding about the market rather than about the request. The
 * first charted comparison market is added, and only that one: the engine
 * compares the primary against one partner.
 *
 * Added to what the run *loads*, not to what it searches. Searched, the
 * partner was traded as well, and a run told to trade NQ became a run on NQ
 * and ES. The engine reads a loaded market it is not searching as the
 * reference only. `addedForSmt` names it so the panel can say so.
 */
export function searchedSymbols(params: {
  primarySymbol: string
  /** The charted markets, primary first. */
  symbols: string[]
  search: SearchConfig
  detectors?: DetectorFilters
}): { symbols: string[]; addedForSmt: string[] } {
  const { primarySymbol, symbols, search, detectors } = params
  const named = search.searchSymbols.length ? search.searchSymbols : symbols
  const searched = Array.from(new Set([primarySymbol, ...named]))
  if (!detectors?.require_smt_divergence || searched.length > 1) {
    return { symbols: searched, addedForSmt: [] }
  }
  const partner = symbols.find((symbol) => !searched.includes(symbol))
  return partner
    ? { symbols: [...searched, partner], addedForSmt: [partner] }
    : { symbols: searched, addedForSmt: [] }
}

/**
 * Turn workspace state into the request the backend expects.
 *
 * Two ways to say where the engine may look. A **test window** dragged on the
 * chart is explicit -- test exactly this stretch of history, leave everything
 * else alone -- and wins when it is set. Without one, the lookback runs back
 * from the end of the loaded range by however many days the field says.
 *
 * Either way it runs right up to the end of the range: the server excludes
 * the selected setup itself from the search, so overlapping the two is safe
 * and gives the pattern the most history to match against.
 *
 * **The run is made at the setup's own bar size.** The engine re-reads the
 * selected range at the request's interval, so any other interval quietly
 * swaps the pattern for a different one: with the interval link off, a setup
 * of 49 five-minute bars was sent at the toolbar's 1h and tested as five
 * hourly ones. Taking the interval from the selection makes that mismatch
 * impossible rather than something to report, and the store drops the
 * selection whenever the primary pane's bar size changes, so the two agree in
 * every flow anyway. Refusing instead would surface as an exception in the
 * Run click handler, which builds the request before the mutation exists to
 * report one -- a button that does nothing.
 */
export function buildBacktestRequest(params: {
  selection: SelectionRange
  primarySymbol: string
  /** The charted markets, primary first. */
  symbols: string[]
  /**
   * The primary pane's bar size. Only a fallback: the selection's own
   * `source_interval` wins, for the reason above.
   */
  interval?: Interval
  rules: TradeRules
  search: SearchConfig
  /** Defaults to requiring nothing, which is how a run behaves with no
   *  conditions set. */
  detectors?: DetectorFilters
  /** Defaults to off, which is how a run behaves with no fitting. */
  learning?: LearningSettings
  rangeEnd: number
  /** Explicit history to search. Overrides the lookback when set. */
  testWindow?: TimeWindow | null
  /** Which timeframe the bias is read from, when the condition is on. */
  higherTimeframe?: Interval | null
}): BacktestRequest {
  const {
    selection,
    primarySymbol,
    symbols,
    rules,
    search,
    detectors = DEFAULT_DETECTOR_FILTERS,
    learning = DEFAULT_LEARNING_SETTINGS,
    rangeEnd,
    testWindow,
    higherTimeframe = null,
  } = params
  const interval: Interval = selection.source_interval ?? params.interval

  const lookbackStart = testWindow
    ? Math.min(testWindow.start_time, testWindow.end_time)
    : rangeEnd - search.lookbackDays * DAY_MS
  const lookbackEnd = testWindow
    ? Math.max(testWindow.start_time, testWindow.end_time)
    : rangeEnd
  const effectiveDetectors = canReadBias(interval) ? detectors : {
    ...detectors, require_higher_timeframe_bias: false,
  }
  // `symbols` carries an SMT partner so the engine can load it; the search
  // stays on the markets that were named, so the partner is compared against
  // and never traded.
  const { symbols: uniqueSymbols, addedForSmt } = searchedSymbols({
    primarySymbol,
    symbols,
    search,
    detectors: effectiveDetectors,
  })
  const searchSymbols = uniqueSymbols.filter((symbol) => !addedForSmt.includes(symbol))

  return {
    symbols: uniqueSymbols,
    primary_symbol: primarySymbol,
    interval,
    // Sent only when the bias condition is actually on. The backend refuses
    // a higher timeframe equal to or finer than the entry one, and a stored
    // setting left over from a coarser interval would otherwise fail a run
    // that never asked for a bias in the first place.
    higher_timeframe: effectiveDetectors.require_higher_timeframe_bias
      ? coarserOf(higherTimeframe ?? interval, interval)
      : null,
    selection: {
      start_time: selection.start_time,
      end_time: selection.end_time,
    },
    trade: rules,
    search: {
      lookback_start: lookbackStart,
      lookback_end: lookbackEnd,
      pattern_length: search.patternLength,
      maximum_matches: Math.min(MAX_PATTERN_MATCHES, Math.max(1, Math.round(search.maximumMatches))),
      minimum_similarity: search.minimumSimilarity,
      minimum_separation_bars: null,
      search_symbols: searchSymbols,
    },
    detectors: effectiveDetectors,
    learning,
  }
}

/**
 * Run a backtest, and put the result on screen when it lands.
 *
 * Everything that has to happen on completion happens here, in the hook's own
 * callbacks, rather than in options passed to `mutate`. Those belong to the
 * component that called it and are skipped once it has unmounted -- and the
 * Strategy panel is unmounted by focus mode, by the Analysis tab and by
 * collapsing the column. A run finished while any of those was the case and
 * was never opened; one that failed lost its message.
 *
 * Read the running state with `useIsMutating({ mutationKey:
 * RUN_BACKTEST_MUTATION_KEY })` and the failure with `runError` in the
 * workspace store: both survive a remount, where this hook's own result does
 * not.
 */
export function useRunBacktest() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationKey: RUN_BACKTEST_MUTATION_KEY,
    mutationFn: (request: BacktestRequest) => api.createBacktest(request),
    onMutate: () => {
      useWorkspace.getState().setRunError(null)
    },
    onSuccess: (result: BacktestResult) => {
      // Seed the cache so opening the result by id is instant.
      queryClient.setQueryData(['backtest', result.id], result)
      void queryClient.invalidateQueries({ queryKey: ['backtests'] })
      useWorkspace.getState().setActiveBacktestId(result.id)
    },
    onError: (error: Error) => {
      useWorkspace.getState().setRunError(error.message || 'The backtest could not be run.')
    },
  })
}

export function useBacktestHistory() {
  return useQuery({
    queryKey: ['backtests'],
    queryFn: () => api.listBacktests(),
    staleTime: 15_000,
  })
}

export function useBacktestResult(id: string | null) {
  return useQuery({
    queryKey: ['backtest', id],
    queryFn: () => api.getBacktest(id as string),
    enabled: Boolean(id),
    staleTime: Number.POSITIVE_INFINITY,
  })
}
