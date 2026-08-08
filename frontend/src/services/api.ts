/**
 * Typed client for the Market Replay Lab backend.
 *
 * Every market-data request in the application goes through here. The browser
 * never talks to Massive or Yahoo directly -- provider credentials stay on the
 * server.
 */

import type {
  BacktestListItem,
  BacktestRequest,
  BacktestResult,
  Trade,
} from '@/types/backtest'
import type { IctAnalysis } from '@/types/ict'
import type {
  BarsResponse,
  CacheStatsResponse,
  HealthResponse,
  Instrument,
  Interval,
  ProviderStatusResponse,
} from '@/types/market'

export const API_BASE_URL = (
  import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8000'
).replace(/\/$/, '')

/** Stable per-tab id so the backend can enforce one backtest at a time. */
export const SESSION_ID = (() => {
  const key = 'mrl.session-id'
  try {
    const existing = sessionStorage.getItem(key)
    if (existing) return existing
    const created = crypto.randomUUID()
    sessionStorage.setItem(key, created)
    return created
  } catch {
    return 'anonymous'
  }
})()

/** An error carrying a message that is safe to show a user. */
export class ApiError extends Error {
  readonly status: number
  readonly isNetworkError: boolean

  constructor(message: string, status: number, isNetworkError = false) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.isNetworkError = isNetworkError
  }
}

const FRIENDLY_STATUS: Record<number, string> = {
  400: 'That request was not valid. Adjust the settings and try again.',
  404: 'The requested data could not be found.',
  409: 'A backtest is already running. Wait for it to finish.',
  422: 'The configuration could not be used as entered.',
  500: 'The server ran into a problem. Please try again.',
  503: 'Market data is temporarily unavailable. Please try again.',
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-Session-Id': SESSION_ID,
        ...(init?.headers ?? {}),
      },
    })
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') throw error
    throw new ApiError(
      'Cannot reach the Market Replay Lab backend. Check that it is running.',
      0,
      true,
    )
  }

  if (!response.ok) {
    // Prefer the backend's own message: those are written for end users.
    let detail: string | undefined
    try {
      const body = await response.json()
      detail = typeof body?.detail === 'string' ? body.detail : undefined
    } catch {
      detail = undefined
    }
    throw new ApiError(
      detail ?? FRIENDLY_STATUS[response.status] ?? 'Something went wrong.',
      response.status,
    )
  }

  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  providerStatus: () => request<ProviderStatusResponse>('/api/providers/status'),

  symbols: async () => {
    const data = await request<{ symbols: Instrument[] }>('/api/symbols')
    return data.symbols
  },

  bars: (
    params: {
      symbol: string
      interval: Interval
      from: number
      to: number
      refresh?: boolean
    },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({
      symbol: params.symbol,
      interval: params.interval,
      from: String(Math.floor(params.from)),
      to: String(Math.ceil(params.to)),
    })
    if (params.refresh) query.set('refresh', 'true')
    return request<BarsResponse>(`/api/bars?${query.toString()}`, { signal })
  },

  /**
   * Swing points, fair value gaps and SMT divergences for one chart.
   *
   * `reference` symbols are the correlated markets to check for divergence:
   * pass ES and YM while looking at NQ. Omit them and only the single-chart
   * detectors run.
   */
  ict: (
    params: {
      symbol: string
      interval: Interval
      from: number
      to: number
      reference?: string[]
      swingStrength?: number
      minGapPercent?: number
      includeFilledGaps?: boolean
      includeInvalidSmt?: boolean
    },
    signal?: AbortSignal,
  ) => {
    const query = new URLSearchParams({
      symbol: params.symbol,
      interval: params.interval,
      from: String(Math.floor(params.from)),
      to: String(Math.ceil(params.to)),
    })
    if (params.reference?.length) query.set('reference', params.reference.join(','))
    if (params.swingStrength != null) {
      query.set('swing_strength', String(params.swingStrength))
    }
    if (params.minGapPercent != null) {
      query.set('min_gap_percent', String(params.minGapPercent))
    }
    if (params.includeFilledGaps != null) {
      query.set('include_filled_gaps', String(params.includeFilledGaps))
    }
    if (params.includeInvalidSmt != null) {
      query.set('include_invalid_smt', String(params.includeInvalidSmt))
    }
    return request<IctAnalysis>(`/api/ict?${query.toString()}`, { signal })
  },

  createBacktest: (body: BacktestRequest) =>
    request<BacktestResult>('/api/backtests', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  listBacktests: async () => {
    const data = await request<{ backtests: BacktestListItem[] }>('/api/backtests')
    return data.backtests
  },

  getBacktest: (id: string) => request<BacktestResult>(`/api/backtests/${id}`),

  getBacktestTrades: async (id: string) => {
    const data = await request<{ backtest_id: string; trades: Trade[] }>(
      `/api/backtests/${id}/trades`,
    )
    return data.trades
  },

  cacheStats: () => request<CacheStatsResponse>('/api/cache'),

  clearCache: (symbol?: string) =>
    request<{ message: string; detail: string | null }>(
      `/api/cache${symbol ? `?symbol=${symbol}` : ''}`,
      { method: 'DELETE' },
    ),
}
