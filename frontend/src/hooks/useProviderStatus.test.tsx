/**
 * The provider badge is the only thing telling you whether a win rate came
 * from real futures prices or from synthetic demo candles, so a backend that
 * is briefly unreachable at mount must not be allowed to read as a confident
 * "demo mode". These cover the two ways that used to happen.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useProviderStatus } from '@/hooks/useMarketData'
import { api } from '@/services/api'

const LIVE = {
  active_provider: 'massive',
  requested_provider: 'auto',
  fallback_active: false,
  fallback_reason: null,
  massive_api_key_configured: true,
  providers: [],
  fallback_history: [],
}

function wrapper() {
  // Mirrors main.tsx, which turns focus refetching off globally -- the point
  // of the assertions below is that this query opts back in.
  const client = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
  })
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
  return { client, Wrapper }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useProviderStatus', () => {
  it('retries past a transient failure instead of latching onto the error', async () => {
    const providerStatus = vi
      .spyOn(api, 'providerStatus')
      .mockRejectedValueOnce(new Error('backend unreachable'))
      .mockResolvedValue(LIVE as never)

    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useProviderStatus(), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 10_000 })
    expect(providerStatus.mock.calls.length).toBeGreaterThan(1)
    expect(result.current.data?.active_provider).toBe('massive')
  })

  it('opts back into focus refetching despite the global default', async () => {
    vi.spyOn(api, 'providerStatus').mockResolvedValue(LIVE as never)

    const { client, Wrapper } = wrapper()
    const { result } = renderHook(() => useProviderStatus(), { wrapper: Wrapper })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    // The cache narrows `options` to the fetch-time subset, which drops the
    // refetch flags, so reach past it to the options the observer resolved.
    const options = client.getQueryCache().find({ queryKey: ['provider-status'] })
      ?.observers[0]?.options
    expect(options?.refetchOnWindowFocus).toBe(true)
  })

  it('stamps every response with the time it was confirmed', async () => {
    vi.spyOn(api, 'providerStatus').mockResolvedValue(LIVE as never)

    const { Wrapper } = wrapper()
    const { result } = renderHook(() => useProviderStatus(), { wrapper: Wrapper })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    // The badge tooltip renders this, so a stale verdict can be told apart
    // from a fresh one.
    expect(result.current.dataUpdatedAt).toBeGreaterThan(0)
  })
})
