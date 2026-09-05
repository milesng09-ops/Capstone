/**
 * The notice exists to replace something that used to happen silently: a
 * quota rejection swapped real candles for synthetic ones and said nothing.
 * These cover the cases where saying nothing would be wrong, and the cases
 * where saying something would be noise.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { RateLimitNotice } from '@/components/layout/RateLimitNotice'
import { api } from '@/services/api'

function provider(overrides: Record<string, unknown> = {}) {
  return {
    name: 'massive',
    display_name: 'Massive',
    configured: true,
    available: true,
    healthy: false,
    last_error: 'Massive rate limit exceeded (HTTP 429)',
    last_checked_ms: Date.now(),
    cooldown_until_ms: Date.now() + 90_000,
    rate_limited: true,
    notes: null,
    ...overrides,
  }
}

function status(providers: Record<string, unknown>[]) {
  return {
    active_provider: 'yahoo',
    requested_provider: 'auto',
    fallback_active: true,
    fallback_reason: 'Massive rate limit exceeded (HTTP 429)',
    massive_api_key_configured: true,
    providers,
    fallback_history: [],
  }
}

function renderNotice() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return render(<RateLimitNotice />, { wrapper: Wrapper })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('RateLimitNotice', () => {
  it('names the provider and counts down while it is cooling off', async () => {
    vi.spyOn(api, 'providerStatus').mockResolvedValue(status([provider()]) as never)

    renderNotice()

    await waitFor(() => expect(screen.getByRole('status')).toBeInTheDocument())
    expect(screen.getByRole('status')).toHaveTextContent('Massive is rate limiting us')
    expect(screen.getByRole('status')).toHaveTextContent(/retrying in \d+s/)
  })

  it('promises that no generated bars will stand in for the missing range', async () => {
    vi.spyOn(api, 'providerStatus').mockResolvedValue(status([provider()]) as never)

    renderNotice()

    // The whole reason the chart is short. If this sentence goes missing the
    // gap looks like a bug rather than a deliberate refusal.
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(
        /generated bars are never drawn in place of real prices/i,
      ),
    )
  })

  it('says nothing when every provider is healthy', async () => {
    vi.spyOn(api, 'providerStatus').mockResolvedValue(
      status([provider({ healthy: true, rate_limited: false, cooldown_until_ms: null })]) as never,
    )

    renderNotice()

    await waitFor(() => expect(api.providerStatus).toHaveBeenCalled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('says nothing about an outage that is not a quota problem', async () => {
    // A provider that is simply down is a different message with a different
    // remedy, and this bar would misdescribe it as "wait and it will clear".
    vi.spyOn(api, 'providerStatus').mockResolvedValue(
      status([
        provider({ rate_limited: false, last_error: 'Massive server error (HTTP 500)' }),
      ]) as never,
    )

    renderNotice()

    await waitFor(() => expect(api.providerStatus).toHaveBeenCalled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('stops showing once the cool-off deadline has already passed', async () => {
    // The backend keeps the flag set until something succeeds, so a stale
    // flag with an elapsed deadline must not leave a countdown on screen
    // reading "retrying in 0s" forever.
    vi.spyOn(api, 'providerStatus').mockResolvedValue(
      status([provider({ cooldown_until_ms: Date.now() - 5_000 })]) as never,
    )

    renderNotice()

    await waitFor(() => expect(api.providerStatus).toHaveBeenCalled())
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })
})
