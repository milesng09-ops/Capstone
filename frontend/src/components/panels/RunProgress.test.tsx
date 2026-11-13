import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { RunProgress } from '@/components/panels/RunProgress'
import { useWorkspace } from '@/store/workspace'
import type { BacktestJob } from '@/types/backtest'

const job = (patch: Partial<BacktestJob>): BacktestJob => ({
  id: 'job-1', status: 'running', strategy: 'gxt_research', stage: 'Loading NQ 1m candles',
  detail: null, done: 3, total: 14, started_at: Date.now() / 1000 - 125, updated_at: 0,
  finished_at: null, waiting_until: null, backtest_id: null, error: null, error_status: null, ...patch,
})

afterEach(() => useWorkspace.setState({ runJob: null }))

describe('the progress of a running backtest', () => {
  it('names the market loading, the part reached and the time taken', () => {
    useWorkspace.setState({ runJob: job({}) })
    render(<RunProgress />)
    expect(screen.getByRole('status')).toHaveTextContent('Loading NQ 1m candles · part 4 of 14')
    expect(screen.getByRole('status')).toHaveTextContent('2m 05s')
  })

  it('says when it is waiting out the provider quota, rather than look stuck', () => {
    useWorkspace.setState({ runJob: job({
      detail: "Waiting 40s for Massive's rate limit (5 requests per minute)",
      waiting_until: Date.now() / 1000 + 40,
    }) })
    render(<RunProgress />)
    expect(screen.getByRole('status')).toHaveTextContent("Massive's rate limit (5 requests per minute)")
  })

  it('shows nothing when no run is going', () => {
    const { container } = render(<RunProgress />)
    expect(container).toBeEmptyDOMElement()
  })
})
