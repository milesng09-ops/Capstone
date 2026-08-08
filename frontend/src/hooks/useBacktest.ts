/** React Query bindings for running and reloading backtests. */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { api } from '@/services/api'
import type {
  BacktestRequest,
  BacktestResult,
  SearchConfig,
  TradeRules,
} from '@/types/backtest'
import type { Interval, SelectionRange } from '@/types/market'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Turn workspace state into the request the backend expects.
 *
 * The lookback deliberately runs right up to the end of the loaded range: the
 * server excludes the selected window itself from the search, so overlapping
 * the two is safe and gives the pattern the most history to match against.
 */
export function buildBacktestRequest(params: {
  selection: SelectionRange
  primarySymbol: string
  symbols: string[]
  interval: Interval
  rules: TradeRules
  search: SearchConfig
  rangeEnd: number
}): BacktestRequest {
  const { selection, primarySymbol, symbols, interval, rules, search, rangeEnd } = params

  const searchSymbols = search.searchSymbols.length ? search.searchSymbols : symbols
  const uniqueSymbols = Array.from(new Set([primarySymbol, ...searchSymbols]))

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
      lookback_start: rangeEnd - search.lookbackDays * DAY_MS,
      lookback_end: rangeEnd,
      pattern_length: search.patternLength,
      maximum_matches: search.maximumMatches,
      minimum_similarity: search.minimumSimilarity,
      minimum_separation_bars: null,
      search_symbols: uniqueSymbols,
    },
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
