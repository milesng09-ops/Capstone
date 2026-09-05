/**
 * The strip that appears when a market-data provider is rate limiting us.
 *
 * This exists because of what the application deliberately no longer does.
 * A quota rejection used to walk the provider chain down to bundled demo
 * data, and the chart carried on drawing candles as though nothing had
 * happened -- synthetic prices, a real-looking win rate, no way to tell. The
 * chain now stops at real data or at nothing, which is honest but leaves a
 * gap on screen that has to explain itself. This is that explanation.
 *
 * It is a bar under the top bar rather than a toast over the candles: it is
 * about the data currently on screen, it stays true until the cool-off
 * expires, and a notification that fades after four seconds would be gone
 * long before the condition it describes.
 */

import { useEffect, useState } from 'react'
import { Clock, RefreshCw } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/primitives'
import { useProviderStatus } from '@/hooks/useMarketData'
import { PROVIDER_LABELS, type ProviderStatus } from '@/types/market'

/** Ticks once a second, but only while something is actually counting down. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(id)
  }, [active])

  return now
}

function label(provider: ProviderStatus): string {
  return PROVIDER_LABELS[provider.name] ?? provider.display_name ?? provider.name
}

export function RateLimitNotice() {
  const statusQuery = useProviderStatus()
  const queryClient = useQueryClient()

  const limited = statusQuery.data?.providers.find((provider) => provider.rate_limited)
  // A cool-off that has already elapsed is not news. The backend keeps the
  // flag until the next successful call clears it, so the deadline -- not the
  // flag -- is what decides whether this is still happening.
  const until = limited?.cooldown_until_ms ?? null
  const now = useNow(until != null)
  const remaining = until != null ? Math.max(0, Math.ceil((until - now) / 1000)) : 0
  const waiting = Boolean(limited) && remaining > 0

  // The moment the window closes, ask again rather than waiting for the next
  // poll: the user has been watching a countdown reach zero, and a chart that
  // stays empty for another few seconds reads as a broken promise.
  useEffect(() => {
    if (!limited || remaining > 0) return
    void queryClient.invalidateQueries({ queryKey: ['provider-status'] })
    void queryClient.invalidateQueries({ queryKey: ['bars'] })
  }, [limited, remaining, queryClient])

  if (!waiting || !limited) return null

  const name = label(limited)

  const retryNow = () => {
    void queryClient.invalidateQueries({ queryKey: ['bars'] })
    void queryClient.invalidateQueries({ queryKey: ['ict'] })
    void queryClient.invalidateQueries({ queryKey: ['provider-status'] })
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-7 shrink-0 items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-2 text-2xs text-amber-300"
    >
      <Clock size={12} className="shrink-0" />

      <span className="min-w-0 truncate">
        <span className="font-semibold">{name} is rate limiting us.</span>{' '}
        {/*
          Naming the missing candles matters more than naming the error. The
          user's question is not "what went wrong" but "why is the chart
          short", and the answer is that the gap is deliberate.
        */}
        Ranges that are not cached yet stay blank until it reopens -- generated
        bars are never drawn in place of real prices.
      </span>

      <span className="numeric ml-auto shrink-0 tabular-nums">
        retrying in {remaining}s
      </span>

      <Button
        size="sm"
        variant="ghost"
        className="h-5 shrink-0 px-1.5 text-amber-300 hover:text-amber-200"
        onClick={retryNow}
        title="Ask again now, without waiting for the cool-off to expire"
      >
        <RefreshCw size={11} className="mr-1" />
        Retry now
      </Button>
    </div>
  )
}
