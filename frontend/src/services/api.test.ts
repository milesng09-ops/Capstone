/**
 * What a failed request tells the user.
 *
 * `fetch` is stubbed throughout, so nothing here reaches a backend.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiError, api, describeErrorDetail } from '@/services/api'
import type { BacktestRequest } from '@/types/backtest'

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
