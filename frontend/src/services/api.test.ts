import { afterEach, expect, it, vi } from 'vitest'
import { api } from './api'
import type { BacktestRequest } from '@/types/backtest'

afterEach(() => vi.unstubAllGlobals())

it('explains structured validation errors without exposing submitted values', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
    detail: [{ loc: ['body', 'gxt', 'confirmation_bars'], msg: 'Input should be greater than or equal to 3', input: 1 }],
  }), { status: 422 })))
  await expect(api.createBacktest({} as BacktestRequest)).rejects.toThrow(
    'gxt.confirmation_bars: Input should be greater than or equal to 3',
  )
})
