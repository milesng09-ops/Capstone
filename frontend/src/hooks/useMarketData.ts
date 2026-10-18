/** React Query bindings for market data and ICT analysis. */

import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import { isFuturesMarketOpen } from '@/lib/marketHours'
import { api } from '@/services/api'
import type { Interval, ProviderStatusResponse } from '@/types/market'
import type { IctSettings } from '@/types/ict'

/** Bars change only when a new one closes, so they can be cached generously. */
const BAR_STALE_MS = 60_000

/**
 * How often a chart asks again for its bars while the market trades.
 *
 * The backend refetches the bar still forming on every request -- at most
 * once in fifteen seconds per market, however many requests arrive -- so this
 * is what makes the price on screen live. A minute keeps a three-chart
 * workspace at three provider calls a minute, inside a quota of five.
 */
export const LIVE_POLL_MS = 60_000

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
  /** Keep the newest bar current: ask again every minute, and on refocus. */
  live = false,
) {
  return useQuery({
    queryKey: ['bars', symbol, interval, from, to],
    queryFn: ({ signal }) => api.bars({ symbol, interval, from, to }, signal),
    enabled: enabled && Boolean(symbol),
    staleTime: BAR_STALE_MS,
    // The window only moves on the hour, so without these the bar forming now
    // was fetched once and then left as it was until the hour turned: the
    // price on screen could be most of an hour old with nothing to say so.
    // Not in a background tab, where nobody is watching it move.
    refetchInterval: live ? LIVE_POLL_MS : false,
    refetchOnWindowFocus: live,
    // Keeping the previous chart on screen while a new interval loads avoids
    // the panel collapsing to an empty box on every toolbar click -- but only
    // the same market's. The primary pane is one component whichever symbol
    // it shows, so switching it from NQ to an uncached YM handed NQ's candles
    // over as YM's until YM arrived: an NQ price under a YM label, YM's
    // drawings on NQ's scale, and the magnet snapping new YM drawings to NQ
    // prices. A different market starts empty instead.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === symbol ? previous : undefined,
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
      settings.liquidityTolerancePercent,
      settings.liquidityMinTouches,
      settings.includeSweptPools,
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
          liquidityTolerancePercent: settings.liquidityTolerancePercent,
          liquidityMinTouches: settings.liquidityMinTouches,
          includeSweptPools: settings.includeSweptPools,
        },
        signal,
      ),
    enabled: settings.enabled && Boolean(symbol),
    staleTime: BAR_STALE_MS,
    // Same rule as the bars, for the same reason: one market's swings and
    // gaps drawn on another's candles are evidence for nothing.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === symbol ? previous : undefined,
  })
}

/**
 * The least time between two refreshes of one chart's detections.
 *
 * The analysis fetches the compared markets too, at this chart's interval --
 * series the other charts' polling does not keep fresh when the interval link
 * is off. Refreshed on every bar of a 1-minute chart, three unlinked charts on
 * 1m, 5m and 15m asked for about five and a half calls a minute against a
 * quota of five; held to one refresh in five minutes they need under four.
 */
export const DETECTIONS_REFRESH_MS = 5 * 60_000

/**
 * Work a chart's detections out again when a new bar opens.
 *
 * The bars are live; the analysis was not, so a gap or a swing completed by
 * the bar that just closed waited for the hour to turn before it appeared.
 * Only on a new bar, not on every refresh of the one forming: detections are
 * read from closed bars, and the analysis is the heavier request. And not more
 * often than `DETECTIONS_REFRESH_MS`, counting the load that first fetched
 * them. A change of market, interval or window is a new query of its own and
 * is left to it.
 */
export function useDetectionsFollowBars(
  symbol: string,
  interval: Interval,
  from: number,
  to: number,
  lastBarTime: number | null,
): void {
  const queryClient = useQueryClient()
  const seen = useRef<{ key: string; time: number; refreshedAt: number } | null>(null)
  useEffect(() => {
    if (lastBarTime == null) return
    const key = `${symbol}|${interval}|${from}|${to}`
    const now = Date.now()
    const before = seen.current
    if (!before || before.key !== key) {
      seen.current = { key, time: lastBarTime, refreshedAt: now }
      return
    }
    if (lastBarTime <= before.time) return
    if (now - before.refreshedAt < DETECTIONS_REFRESH_MS) {
      // A new bar, but too soon: remembered, so the next one past the wait
      // is the one that refreshes.
      seen.current = { ...before, time: lastBarTime }
      return
    }
    seen.current = { key, time: lastBarTime, refreshedAt: now }
    void queryClient.invalidateQueries({ queryKey: ['ict', symbol, interval, from, to] })
  }, [lastBarTime, symbol, interval, from, to, queryClient])
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

/**
 * Whether the futures market is trading now, re-read every half minute.
 *
 * A live chart polls only while it is: outside the session the provider has
 * nothing new to give, and asking still spends the quota. Watched rather than
 * read once, so a chart left open over the weekend wakes up for Sunday's open.
 */
export function useMarketOpen(): boolean {
  const [open, setOpen] = useState(() => isFuturesMarketOpen())
  useEffect(() => {
    const timer = window.setInterval(() => setOpen(isFuturesMarketOpen()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  return open
}

export function useCacheStats(enabled = true) {
  return useQuery({
    queryKey: ['cache-stats'],
    queryFn: () => api.cacheStats(),
    enabled,
    staleTime: 15_000,
  })
}
