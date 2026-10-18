/** React Query bindings for running and reloading backtests. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/services/api'
import { DEFAULT_DETECTOR_FILTERS, DEFAULT_LEARNING_SETTINGS, MAX_PATTERN_MATCHES } from '@/types/backtest'
import { canReadBias, coarserOf } from '@/store/workspace'
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
 */
export function buildBacktestRequest(params: {
  selection: SelectionRange
  primarySymbol: string
  symbols: string[]
  interval: Interval
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
    interval,
    rules,
    search,
    detectors = DEFAULT_DETECTOR_FILTERS,
    learning = DEFAULT_LEARNING_SETTINGS,
    rangeEnd,
    testWindow,
    higherTimeframe = null,
  } = params

  const searchSymbols = search.searchSymbols.length ? search.searchSymbols : symbols
  const uniqueSymbols = Array.from(new Set([primarySymbol, ...searchSymbols]))

  const lookbackStart = testWindow
    ? Math.min(testWindow.start_time, testWindow.end_time)
    : rangeEnd - search.lookbackDays * DAY_MS
  const lookbackEnd = testWindow
    ? Math.max(testWindow.start_time, testWindow.end_time)
    : rangeEnd
  const effectiveDetectors = canReadBias(interval) ? detectors : {
    ...detectors, require_higher_timeframe_bias: false,
  }

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
      search_symbols: uniqueSymbols,
    },
    detectors: effectiveDetectors,
    learning,
  }
}

export function useRunBacktest() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: (request: BacktestRequest) => api.createBacktest(request),
    onSuccess: (result: BacktestResult) => {
      // Seed the cache so opening the result by id is instant.
      queryClient.setQueryData(['backtest', result.id], result)
      void queryClient.invalidateQueries({ queryKey: ['backtests'] })
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
