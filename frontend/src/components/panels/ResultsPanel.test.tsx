/**
 * A win rate quoted alone is the one number in this app that can be read as
 * a promise. These cover the three things that stop it: the span the sample
 * actually supports, what an arbitrary entry paid under the same rules, and
 * how often chance alone matches the result.
 *
 * The legacy case matters as much as the live one. Runs saved before any of
 * this existed have no interval stored, and inventing a confident-looking
 * "0-0% at 95%" for them would be worse than showing nothing.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { ResultsPanel } from '@/components/panels/ResultsPanel'
import { useWorkspace } from '@/store/workspace'
import type { BacktestResult, BacktestSummary } from '@/types/backtest'

const useBacktestResult = vi.hoisted(() => vi.fn())
vi.mock('@/hooks/useBacktest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useBacktest')>()),
  useBacktestResult,
}))

const SUMMARY: BacktestSummary = {
  total_matches: 25,
  trades_executed: 13,
  skipped_matches: 0,
  wins: 6,
  losses: 7,
  breakeven: 0,
  timeouts: 0,
  win_rate: 46.1538,
  gross_return: 0.9,
  net_return: 0.68,
  average_return: 0.05,
  median_return: 0.0,
  average_winner: 0.9,
  average_loser: -0.64,
  risk_reward_achieved: 1.4,
  profit_factor: 1.2,
  expectancy: 0.05,
  maximum_drawdown: 2.35,
  longest_winning_streak: 2,
  longest_losing_streak: 3,
  average_holding_bars: 9.2,
  win_rate_low: 23.21,
  win_rate_high: 70.86,
  baseline: {
    samples: 500,
    trades_executed: 500,
    win_rate: 37.6,
    average_return: -0.09,
    expectancy: -0.09,
    seed: 10532413940444770088,
  },
  baseline_p_value: 0.355816,
  learned_weights: null,
  configurations_tried: 1,
  family_wise_p_value: 0.355816,
  condition_filtered_matches: 0,
  conditions_applied: [],
  sample_size_warning: null,
  same_bar_ambiguity_count: 0,
  equity_curve: [],
  assumptions: [],
  data_quality: [],
}

function result(summary: BacktestSummary): BacktestResult {
  return {
    id: 'bt-1',
    created_at: 1_789_000_000_000,
    status: 'complete',
    primary_symbol: 'ES',
    symbols: ['ES'],
    interval: '1h',
    selection: { start_time: 1, end_time: 2 },
    provider: 'massive',
    error_message: null,
    configuration: {} as BacktestResult['configuration'],
    summary,
    matches: [],
    trades: [],
  }
}

function show(summary: BacktestSummary) {
  useBacktestResult.mockReturnValue({
    data: result(summary),
    isLoading: false,
    isError: false,
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<ResultsPanel />, { wrapper: Wrapper })
}

beforeEach(() => {
  useBacktestResult.mockReset()
  useWorkspace.getState().setActiveBacktestId('bt-1')
})

describe('the win rate is never quoted alone', () => {
  it('shows the span the sample supports beside the rate', () => {
    show(SUMMARY)
    expect(screen.getByText('46.2%')).toBeInTheDocument()
    // 13 trades cannot pin a rate to a point, and the panel says so.
    expect(screen.getByText(/23.+71% at 95%/)).toBeInTheDocument()
  })

  it('names what an arbitrary entry paid under the same rules', () => {
    show(SUMMARY)
    expect(screen.getByText(/Random entry 37\.6%/)).toBeInTheDocument()
  })

  it('puts the p-value in odds rather than a decimal', () => {
    // "0.36" reads as a small number to anyone skimming. "1 in 3" does not.
    show(SUMMARY)
    expect(screen.getByText(/chance alone: 1 in 3/)).toBeInTheDocument()
  })

  it('reports long odds without claiming a precision it does not have', () => {
    show({ ...SUMMARY, baseline_p_value: 0.0002 })
    expect(screen.getByText(/under 1 in 1,000/)).toBeInTheDocument()
  })
})

describe('runs saved before any of this existed', () => {
  const legacy: BacktestSummary = {
    ...SUMMARY,
    win_rate_low: 0,
    win_rate_high: 0,
    baseline: null,
    baseline_p_value: null,
  }

  it('shows the rate but claims no interval for it', () => {
    show(legacy)
    expect(screen.getByText('46.2%')).toBeInTheDocument()
    expect(screen.queryByText(/at 95%/)).not.toBeInTheDocument()
  })

  it('offers no baseline it never measured', () => {
    show(legacy)
    expect(screen.queryByText(/Random entry/)).not.toBeInTheDocument()
    expect(screen.queryByText(/chance alone/)).not.toBeInTheDocument()
  })
})

describe('once the same window has been asked more than once', () => {
  it('quotes the family-wise odds, not the single-test ones', () => {
    // The flattering version of this panel shows 1 in 33 here. Ten draws at
    // that threshold clear it a quarter of the time on their own.
    show({
      ...SUMMARY,
      baseline_p_value: 0.03,
      configurations_tried: 10,
      family_wise_p_value: 0.2626,
    })
    expect(screen.getByText(/1 in 4/)).toBeInTheDocument()
    expect(screen.queryByText(/1 in 33/)).not.toBeInTheDocument()
  })

  it('says how many configurations the odds cover', () => {
    show({
      ...SUMMARY,
      baseline_p_value: 0.03,
      configurations_tried: 10,
      family_wise_p_value: 0.2626,
    })
    expect(screen.getByText(/across 10 configurations tried here/)).toBeInTheDocument()
  })

  it('leaves a first run reading as a single test', () => {
    show({ ...SUMMARY, baseline_p_value: 0.03, configurations_tried: 1, family_wise_p_value: 0.03 })
    expect(screen.getByText(/1 in 33/)).toBeInTheDocument()
    expect(screen.queryByText(/configurations tried/)).not.toBeInTheDocument()
  })
})

describe('when the similarity weights were fitted', () => {
  const fit = {
    weights: { normalised_close: 1, returns: 0, body: 0.6 },
    train_score: 0.1413,
    default_score: -0.0056,
    improved: true,
    labelled_windows: 1462,
    query_windows: 60,
    top_k: 25,
    passes: 2,
    objective: 'expectancy',
    dropped_blocks: ['returns'],
    group_weights: null,
    exhaustive: false,
    holdout_score: -0.1044,
    holdout_default_score: -0.0702,
    holdout_windows: 1434,
    generalised: false,
    train_start: 1,
    train_end: 2,
  }

  it('leads with the holdout verdict, not the training one', () => {
    // `improved` is true here. Leading with it would sell a fit that hurt.
    show({ ...SUMMARY, learned_weights: fit })
    expect(screen.getByText(/did not hold up/)).toBeInTheDocument()
  })

  it('shows both halves so the gap is visible', () => {
    show({ ...SUMMARY, learned_weights: fit })
    const banner = screen.getByText(/did not hold up/)
    expect(banner.textContent).toMatch(/0\.141/)
    expect(banner.textContent).toMatch(/-0\.104/)
  })

  it('prints the whole model', () => {
    // Seven numbers is small enough to read, and a model you can read is one
    // you can argue with.
    show({ ...SUMMARY, learned_weights: fit })
    expect(screen.getByText(/normalised close/)).toBeInTheDocument()
  })

  it('says so when the fit did hold up', () => {
    show({
      ...SUMMARY,
      learned_weights: { ...fit, holdout_score: -0.02, generalised: true },
    })
    expect(screen.getByText(/beat the hand-set ones/)).toBeInTheDocument()
  })

  it('claims no verdict when there was no holdout to judge on', () => {
    show({ ...SUMMARY, learned_weights: { ...fit, generalised: null } })
    expect(screen.getByText(/too small to judge/)).toBeInTheDocument()
  })
})
