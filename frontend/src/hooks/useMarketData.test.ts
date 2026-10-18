/**
 * What a chart shows while the next one loads.
 *
 * The primary pane is a single component whichever market it is showing, so
 * a change of primary symbol is a change of query key on the same observer
 * -- which is exactly where placeholder data applies.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useBars, useIct } from '@/hooks/useMarketData'
import { api } from '@/services/api'
import { DEFAULT_ICT_SETTINGS } from '@/types/ict'
import type { Interval } from '@/types/market'

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { refetchOnWindowFocus: false, retry: false } },
  })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

/** Answers for NQ at once and leaves every other market loading. */
function nqOnly<T>(answer: (symbol: string, interval: string) => T) {
  return ({ symbol, interval }: { symbol: string; interval: string }) =>
    symbol === 'NQ' ? Promise.resolve(answer(symbol, interval)) : new Promise<T>(() => {})
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useBars while another series loads', () => {
  const bars = (symbol: string, interval: string) => {
    const candle = { symbol, time: 1, open: 1, high: 1, low: 1, close: 20_150, volume: 1 }
    return { symbol, interval, bars: [candle] } as never
  }

  it("does not show one market's candles under another's name", async () => {
    vi.spyOn(api, 'bars').mockImplementation(nqOnly(bars))

    const { result, rerender } = renderHook(
      ({ symbol }: { symbol: string }) => useBars(symbol, '1h', 0, 1),
      { wrapper: wrapper(), initialProps: { symbol: 'NQ' } },
    )
    await waitFor(() => expect(result.current.data?.symbol).toBe('NQ'))

    rerender({ symbol: 'YM' })

    expect(result.current.data).toBeUndefined()
  })

  it('keeps the same market on screen while its new interval loads', async () => {
    vi.spyOn(api, 'bars').mockImplementation(({ symbol, interval }) =>
      interval === '1h' ? Promise.resolve(bars(symbol, interval)) : new Promise(() => {}),
    )

    const { result, rerender } = renderHook(
      ({ interval }: { interval: Interval }) => useBars('NQ', interval, 0, 1),
      { wrapper: wrapper(), initialProps: { interval: '1h' as Interval } },
    )
    await waitFor(() => expect(result.current.data?.symbol).toBe('NQ'))

    rerender({ interval: '4h' })

    expect(result.current.data?.symbol).toBe('NQ')
    expect(result.current.isPlaceholderData).toBe(true)
  })
})

describe('useIct while another series loads', () => {
  const analysis = (symbol: string) => ({ symbol, swing_points: [] }) as never

  it("does not show one market's detections on another's chart", async () => {
    vi.spyOn(api, 'ict').mockImplementation(nqOnly(analysis))

    const { result, rerender } = renderHook(
      ({ symbol }: { symbol: string }) =>
        useIct(symbol, '1h', 0, 1, ['ES'], DEFAULT_ICT_SETTINGS),
      { wrapper: wrapper(), initialProps: { symbol: 'NQ' } },
    )
    await waitFor(() => expect(result.current.data?.symbol).toBe('NQ'))

    rerender({ symbol: 'YM' })

    expect(result.current.data).toBeUndefined()
  })
})
