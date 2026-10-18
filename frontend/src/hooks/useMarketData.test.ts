/**
 * What a chart shows while the next one loads.
 *
 * The primary pane is a single component whichever market it is showing, so
 * a change of primary symbol is a change of query key on the same observer
 * -- which is exactly where placeholder data applies.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  LIVE_POLL_MS,
  useBars,
  useDetectionsFollowBars,
  useIct,
} from '@/hooks/useMarketData'
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

describe('a live chart', () => {
  // The window only moves on the hour, so the bar forming now was fetched once
  // and left as it was: the price on screen could be most of an hour old.
  afterEach(() => {
    vi.useRealTimers()
  })

  async function callsAfterAMinute(live: boolean) {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const bars = vi
      .spyOn(api, 'bars')
      .mockResolvedValue({ symbol: 'NQ', interval: '1h', bars: [] } as never)
    renderHook(() => useBars('NQ', '1h', 0, 1, true, live), { wrapper: wrapper() })
    await waitFor(() => expect(bars).toHaveBeenCalledTimes(1))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(LIVE_POLL_MS + 100)
    })
    return bars.mock.calls.length
  }

  it('asks for its bars again every minute while the market trades', async () => {
    expect(await callsAfterAMinute(true)).toBe(2)
  })

  it('leaves them alone otherwise, as the quota would want', async () => {
    expect(await callsAfterAMinute(false)).toBe(1)
  })
})

describe('detections following the bars', () => {
  function follow(client: QueryClient) {
    return renderHook(
      ({ symbol, time }: { symbol: string; time: number | null }) =>
        useDetectionsFollowBars(symbol, '1h', 0, 10, time),
      {
        wrapper: ({ children }: { children: ReactNode }) =>
          createElement(QueryClientProvider, { client }, children),
        initialProps: { symbol: 'NQ', time: 100 as number | null },
      },
    )
  }

  it('works the detections out again when a new bar opens', () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { rerender } = follow(client)

    // The forming bar refreshed: same bar, nothing to redo.
    rerender({ symbol: 'NQ', time: 100 })
    expect(invalidate).not.toHaveBeenCalled()

    rerender({ symbol: 'NQ', time: 200 })
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['ict', 'NQ', '1h', 0, 10] })
  })

  it('leaves a change of market to the new query it makes anyway', () => {
    const client = new QueryClient()
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    const { rerender } = follow(client)

    rerender({ symbol: 'ES', time: 300 })
    expect(invalidate).not.toHaveBeenCalled()
  })
})
