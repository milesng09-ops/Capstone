import { render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'

import { TradesTable } from '@/components/panels/TradesTable'
import type { Trade } from '@/types/backtest'

// The backend's stamp for Monday 12 Oct's daily bar: the 17:00 Chicago session
// that opens on the Sunday evening before it.
const mondaySession = Date.UTC(2026, 9, 11, 22)

const trade: Trade = {
  id: 't1',
  trade_number: 1,
  pattern_match_id: 'm1',
  symbol: 'ES',
  direction: 'long',
  entry_time: mondaySession,
  exit_time: mondaySession + 86_400_000,
  entry_price: 100,
  exit_price: 101,
  stop_price: 99,
  target_price: 102,
  gross_return: 1,
  fees: 0,
  net_return: 1,
  exit_reason: 'take_profit',
  holding_bars: 1,
  similarity_score: 0.9,
  same_bar_ambiguity: false,
}

it('dates a daily run by the day each trade traded, as the axis does', () => {
  render(<TradesTable trades={[trade]} selectedId={null} onSelect={vi.fn()} interval="1d" />)
  expect(screen.getByText('12 Oct 2026')).toBeInTheDocument()
})
