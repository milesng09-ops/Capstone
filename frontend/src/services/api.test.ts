import { afterEach, expect, it, vi } from 'vitest'
import { api } from './api'
import type { BacktestRequest } from '@/types/backtest'
import { useErrorLog } from '@/lib/errorLog'

afterEach(() => vi.unstubAllGlobals())

it('logs network errors and malformed successful responses but ignores cancellations', async () => {
  useErrorLog.getState().clear()
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
  await expect(api.health()).rejects.toThrow('Cannot reach')
  expect(useErrorLog.getState().entries[0].status).toBe(0)
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>Bad gateway</html>')))
  await expect(api.health()).rejects.toThrow('unreadable response')
  expect(useErrorLog.getState().entries).toHaveLength(2)
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError')))
  await expect(api.health()).rejects.toThrow('Aborted')
  expect(useErrorLog.getState().entries).toHaveLength(2)
})

it('retains the server reference without logging response credentials', async () => {
  useErrorLog.getState().clear()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ detail: 'apiKey=private-value unavailable' }), {
    status: 503, headers: { 'X-Request-ID': 'server-reference' },
  })))
  await expect(api.health()).rejects.toThrow('[redacted]')
  expect(useErrorLog.getState().entries[0].requestId).toBe('server-reference')
  expect(JSON.stringify(useErrorLog.getState().entries)).not.toContain('private-value')
})

it('explains structured validation errors without exposing submitted values', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    detail: [{ loc: ['body', 'gxt', 'confirmation_bars'], msg: 'Input should be greater than or equal to 3', input: 1 }],
  }), { status: 422 })))
  await expect(api.createBacktest({} as BacktestRequest)).rejects.toThrow(
    'gxt.confirmation_bars: Input should be greater than or equal to 3',
  )
})
