/** React Query bindings for market data and ICT analysis. */

import { useQuery } from '@tanstack/react-query'

import { api } from '@/services/api'
import type { Interval, ProviderStatusResponse } from '@/types/market'
import type { IctSettings } from '@/types/ict'

/** Bars change only when a new one closes, so they can be cached generously. */
const BAR_STALE_MS = 60_000

const IDLE_POLL_MS = 60_000
const COOLDOWN_POLL_MS = 5_000

/** True while any provider is inside a failure cool-off it will come out of. */
function isCoolingOff(status: ProviderStatusResponse | undefined): boolean {
  if (!status) return false
  const now = Date.now()
  return status.providers.some(
    (provider) => provider.cooldown_until_ms != null && provider.cooldown_until_ms > now,
  )
}

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

/**
 * Which provider is actually serving candles, polled once a minute.
 *
 * A backend that is briefly down at mount used to pin the whole UI to demo
 * mode for a full minute, silently: the badges read from this one response,
 * so a strategy tested in that window would be scored on synthetic prices
 * while looking exactly like a live run. Hence the retries -- a hiccup at
 * load should not be mistaken for an answer -- and the refetch on focus, so
 * coming back to the tab re-asks instead of trusting a minute-old verdict.
 *
 * While a provider is cooling off the poll tightens to five seconds. A quota
 * cool-off is around two minutes, so a minute-long poll would report the
 * recovery up to a minute after it happened -- long enough for the user to
 * conclude it is still broken and go looking for a setting to change.
 */
export function useProviderStatus() {
  return useQuery({
    queryKey: ['provider-status'],
    queryFn: () => api.providerStatus(),
    refetchInterval: (query) =>
      isCoolingOff(query.state.data) ? COOLDOWN_POLL_MS : IDLE_POLL_MS,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
    retry: 3,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 8_000),
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
