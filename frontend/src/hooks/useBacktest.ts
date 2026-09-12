/** React Query bindings for running and reloading backtests. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/services/api'
import { DEFAULT_DETECTOR_FILTERS } from '@/types/backtest'
import type {
  BacktestRequest,
  BacktestResult,
  DetectorFilters,
  SearchConfig,
  TradeRules,
} from '@/types/backtest'
import type { Interval, SelectionRange, TimeWindow } from '@/types/market'

const DAY_MS = 24 * 60 * 60 * 1000

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
  rangeEnd: number
  /** Explicit history to search. Overrides the lookback when set. */
  testWindow?: TimeWindow | null
}): BacktestRequest {
  const {
    selection,
    primarySymbol,
    symbols,
    interval,
    rules,
    search,
    detectors = DEFAULT_DETECTOR_FILTERS,
    rangeEnd,
    testWindow,
  } = params

  const searchSymbols = search.searchSymbols.length ? search.searchSymbols : symbols
  const uniqueSymbols = Array.from(new Set([primarySymbol, ...searchSymbols]))

  const lookbackStart = testWindow
    ? Math.min(testWindow.start_time, testWindow.end_time)
    : rangeEnd - search.lookbackDays * DAY_MS
  const lookbackEnd = testWindow
    ? Math.max(testWindow.start_time, testWindow.end_time)
    : rangeEnd

  return {
    symbols: uniqueSymbols,
    primary_symbol: primarySymbol,
    interval,
    selection: {
      start_time: selection.start_time,
      end_time: selection.end_time,
    },
    trade: rules,
    search: {
      lookback_start: lookbackStart,
      lookback_end: lookbackEnd,
      pattern_length: search.patternLength,
      maximum_matches: search.maximumMatches,
      minimum_similarity: search.minimumSimilarity,
      minimum_separation_bars: null,
      search_symbols: uniqueSymbols,
    },
    detectors,
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
