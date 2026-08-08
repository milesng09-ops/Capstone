/** React Query bindings for market data and ICT analysis. */

import { useQuery } from '@tanstack/react-query'

import { api } from '@/services/api'
import type { Interval } from '@/types/market'
import type { IctSettings } from '@/types/ict'

/** Bars change only when a new one closes, so they can be cached generously. */
const BAR_STALE_MS = 60_000

export function useSymbols() {
  return useQuery({
    queryKey: ['symbols'],
    queryFn: () => api.symbols(),
    staleTime: Number.POSITIVE_INFINITY,
  })
}

export function useBars(
  symbol: string,
  interval: Interval,
  from: number,
  to: number,
  enabled = true,
) {
  return useQuery({
    queryKey: ['bars', symbol, interval, from, to],
    queryFn: ({ signal }) => api.bars({ symbol, interval, from, to }, signal),
    enabled: enabled && Boolean(symbol),
    staleTime: BAR_STALE_MS,
    // Keeping the previous chart on screen while a new interval loads avoids
    // the panel collapsing to an empty box on every toolbar click.
    placeholderData: (previous) => previous,
  })
}

export function useIct(
  symbol: string,
  interval: Interval,
  from: number,
  to: number,
  references: string[],
  settings: IctSettings,
) {
  return useQuery({
    queryKey: [
      'ict',
      symbol,
      interval,
      from,
      to,
      references.join(','),
      settings.swingStrength,
      settings.minGapPercent,
      settings.includeFilledGaps,
      settings.includeInvalidSmt,
    ],
    queryFn: ({ signal }) =>
      api.ict(
        {
          symbol,
          interval,
          from,
          to,
          reference: references,
          swingStrength: settings.swingStrength,
          minGapPercent: settings.minGapPercent,
          includeFilledGaps: settings.includeFilledGaps,
          includeInvalidSmt: settings.includeInvalidSmt,
        },
        signal,
      ),
    enabled: settings.enabled && Boolean(symbol),
    staleTime: BAR_STALE_MS,
    placeholderData: (previous) => previous,
  })
}

export function useProviderStatus() {
  return useQuery({
    queryKey: ['provider-status'],
    queryFn: () => api.providerStatus(),
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
}

export function useCacheStats(enabled = true) {
  return useQuery({
    queryKey: ['cache-stats'],
    queryFn: () => api.cacheStats(),
    enabled,
    staleTime: 15_000,
  })
}
