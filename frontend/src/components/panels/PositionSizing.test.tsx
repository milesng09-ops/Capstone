import { act, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it } from 'vitest'

import { PositionSizing } from '@/components/panels/PositionSizing'
import { useWorkspace } from '@/store/workspace'
import { DEFAULT_SIZING } from '@/types/backtest'

beforeEach(() => {
  useWorkspace.getState().updateSizing(DEFAULT_SIZING)
})

describe('PositionSizing risk budget', () => {
  it('shows the budget in money with nothing selected on the chart', () => {
    // The whole point of the figure: a percentage of the account needs no
    // setup, no levels and no plan, so it must not wait for one.
    render(<PositionSizing candles={[]} setup={null} />)
    expect(screen.getByText('Select a setup on the chart to price it.')).toBeInTheDocument()
    // 1% of the default $100,000 account.
    expect(screen.getByText('$1,000')).toBeInTheDocument()
  })

  it('follows the risk preset it sits beside', async () => {
    render(<PositionSizing candles={[]} setup={null} />)
    await userEvent.click(screen.getByRole('button', { name: '2%' }))
    expect(screen.getByText('$2,000')).toBeInTheDocument()
  })

  it('follows the account equity field', () => {
    render(<PositionSizing candles={[]} setup={null} />)
    act(() => useWorkspace.getState().updateSizing({ accountEquity: 25_000 }))
    expect(screen.getByText('$250')).toBeInTheDocument()
  })
})
