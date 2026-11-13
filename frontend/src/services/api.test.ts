/**
 * What a failed request tells the user.
 *
 * `fetch` is stubbed throughout, so nothing here reaches a backend.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, api, describeErrorDetail } from '@/services/api'
import type { BacktestRequest } from '@/types/backtest'
import { useErrorLog } from '@/lib/errorLog'

function respond(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    ),
  )
}

async function failure(): Promise<ApiError> {
  try {
    await api.createBacktest({} as BacktestRequest)
  } catch (error) {
    return error as ApiError
  }
  throw new Error('the request was expected to fail')
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('a request the backend refused', () => {
  it('says which rule a validation error broke, not just that one did', async () => {
    // FastAPI's own 422: a list, not a sentence. The schema validator wrote
    // the message for a user, and it used to be thrown away.
    respond(422, {
      detail: [
        {
          type: 'value_error',
          loc: ['body', 'detectors'],
          msg: 'Value error, detectors.fib_low must not exceed fib_high',
          input: {},
        },
      ],
    })

    const error = await failure()

    expect(error).toBeInstanceOf(ApiError)
    expect(error.status).toBe(422)
    expect(error.message).toBe('detectors.fib_low must not exceed fib_high')
  })

  it('names the field when the message alone would not', async () => {
    respond(422, {
      detail: [
        {
          type: 'less_than_equal',
          loc: ['body', 'trade', 'maximum_holding_bars'],
          msg: 'Input should be less than or equal to 2000',
        },
        {
          type: 'greater_than_equal',
          loc: ['body', 'learning', 'train_fraction'],
          msg: 'Input should be greater than or equal to 0.2',
        },
      ],
    })

    expect((await failure()).message).toBe(
      'trade.maximum_holding_bars: Input should be less than or equal to 2000; ' +
        'learning.train_fraction: Input should be greater than or equal to 0.2',
    )
  })

  it('keeps a sentence the route wrote itself', async () => {
    respond(422, { detail: 'The lookback range does not contain enough candles.' })

    expect((await failure()).message).toBe(
      'The lookback range does not contain enough candles.',
    )
  })

  it('falls back to the status text when there is nothing to read', async () => {
    respond(422, { detail: [{ loc: ['body'] }] })

    expect((await failure()).message).toBe(
      'The configuration could not be used as entered.',
    )
  })
})

describe('describeErrorDetail', () => {
  it('drops the location roots every entry shares', () => {
    const detail = [
      {
        loc: ['query', 'liquidity_min_touches'],
        msg: 'Input should be greater than or equal to 2',
      },
    ]

    expect(describeErrorDetail(detail)).toBe(
      'liquidity_min_touches: Input should be greater than or equal to 2',
    )
  })

  it('ignores shapes it does not recognise', () => {
    expect(describeErrorDetail(undefined)).toBeUndefined()
    expect(describeErrorDetail({ msg: 'not a list' })).toBeUndefined()
    expect(describeErrorDetail([null, 3, { msg: '' }])).toBeUndefined()
  })
})

describe('the session id', () => {
  it('is minted on an origin without crypto.randomUUID', async () => {
    // Plain http on a LAN address: the call threw, and every such tab shared
    // the `anonymous` bucket -- so one tab's run blocked another's.
    sessionStorage.removeItem('mrl.session-id')
    vi.stubGlobal('crypto', { getRandomValues: crypto.getRandomValues.bind(crypto) })
    vi.resetModules()

    const { SESSION_ID } = await import('@/services/api')

    expect(SESSION_ID).not.toBe('anonymous')
    expect(SESSION_ID).toMatch(/^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$/)
    expect(sessionStorage.getItem('mrl.session-id')).toBe(SESSION_ID)
  })
})

describe('a GXT setting the backend refused', () => {
  it('names the GXT field without echoing the submitted value', async () => {
    respond(422, {
      detail: [{ loc: ['body', 'gxt', 'confirmation_bars'], msg: 'Input should be greater than or equal to 3', input: 1 }],
    })
    expect((await failure()).message).toBe('gxt.confirmation_bars: Input should be greater than or equal to 3')
  })
})

describe('the error log', () => {
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
})

describe('a backtest run as a background job', () => {
  const job = (patch: Record<string, unknown>) => ({
    id: 'job-1', status: 'running', strategy: 'gxt_research', stage: 'Loading NQ 1m candles',
    detail: null, done: 1, total: 14, started_at: 0, updated_at: 0, finished_at: null,
    waiting_until: null, backtest_id: null, error: null, error_status: null, ...patch,
  })
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  it('follows the job through its progress to the stored run', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(job({}), 202))
      .mockResolvedValueOnce(json(job({ done: 7 })))
      .mockResolvedValueOnce(json(job({ status: 'succeeded', backtest_id: 'run-9' })))
      .mockResolvedValueOnce(json({ id: 'run-9', trades: [] }))
    vi.stubGlobal('fetch', fetch)
    vi.spyOn(api, 'followBacktestJob').mockImplementationOnce(
      (id, onProgress) => api.followBacktestJob(id, onProgress, 0),
    )
    const seen: number[] = []
    const result = await api.runBacktest({} as BacktestRequest, (j) => seen.push(j.done ?? -1))
    expect(result.id).toBe('run-9')
    expect(seen).toEqual([1, 7, 1])
    expect(fetch.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining('/api/backtests/jobs'),
      expect.stringContaining('/api/backtests/jobs/job-1'),
      expect.stringContaining('/api/backtests/jobs/job-1'),
      expect.stringContaining('/api/backtests/run-9'),
    ])
  })

  it('throws a failed job as the error it ended with, and logs it', async () => {
    useErrorLog.getState().clear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(job({
      status: 'failed', error: 'Insufficient GXT history.', error_status: 422,
    }))))
    await expect(api.followBacktestJob('job-1', undefined, 0)).rejects.toMatchObject({
      message: 'Insufficient GXT history.', status: 422,
    })
    expect(useErrorLog.getState().entries[0]).toMatchObject({ context: 'Backtest (GXT)', status: 422 })
  })

  it('rides out a dropped poll but gives up on a backend that stays away', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json(job({ status: 'succeeded', backtest_id: 'run-2' })))
      .mockResolvedValueOnce(json({ id: 'run-2', trades: [] }))
    vi.stubGlobal('fetch', fetch)
    expect((await api.followBacktestJob('job-1', undefined, 0)).id).toBe('run-2')

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    await expect(api.followBacktestJob('job-1', undefined, 0)).rejects.toThrow('Cannot reach')
  })

  it('treats "no job in this tab" as an answer, not an error to log', async () => {
    useErrorLog.getState().clear()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ detail: 'No backtest has been started in this tab.' }, 404)))
    expect(await api.currentBacktestJob()).toBeNull()
    expect(useErrorLog.getState().entries).toHaveLength(0)
  })
})
