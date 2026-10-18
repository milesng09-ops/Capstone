/**
 * The bar across the top, for the two things it says that jsdom can check.
 *
 * Which comparison markets are on was carried by colour alone, so a screen
 * reader heard two identical "ES" and "YM" buttons. And the saved runs were
 * offered only from 1280px: on a 1024-1279px laptop there was no way at all to
 * put an earlier run back on screen.
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { TopBar } from '@/components/layout/TopBar'
import { api } from '@/services/api'
import { useWorkspace } from '@/store/workspace'
import type { BacktestListItem } from '@/types/backtest'

const RUN: BacktestListItem = {
  id: 'run-1',
  created_at: 1_789_000_000_000,
  primary_symbol: 'NQ',
  interval: '1h',
  status: 'complete',
  selection_start: 1_788_000_000_000,
  selection_end: 1_788_010_000_000,
  label: 'default rules',
  trades_executed: 12,
  win_rate: 41.6,
  net_return: 1.2,
}

function renderBar() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const Wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  )
  return render(<TopBar />, { wrapper: Wrapper })
}

beforeEach(() => {
  // Neither request matters to these tests; both are kept off the network.
  vi.spyOn(api, 'providerStatus').mockReturnValue(new Promise(() => {}))
  vi.spyOn(api, 'listBacktests').mockResolvedValue([RUN])
  useWorkspace.setState({ primarySymbol: 'NQ', compareSymbols: ['ES'] })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the comparison toggles', () => {
  it('say which markets are compared in words, not only in colour', () => {
    renderBar()
    const group = screen.getByTitle(/correlated markets charted alongside/i)

    expect(within(group).getByRole('button', { name: 'ES' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
    expect(within(group).getByRole('button', { name: 'YM' })).toHaveAttribute(
      'aria-pressed',
      'false',
    )
  })
})

describe('the saved runs', () => {
  it('are offered from a laptop width, not only on a wide monitor', async () => {
    renderBar()
    const picker = await screen.findByRole('combobox', { name: /run/i })

    // Shown from `lg` (1024px), narrower there than on a wide screen.
    const label = picker.closest('label')
    expect(label?.className).toMatch(/(^|\s)lg:flex(\s|$)/)
    expect(label?.className).not.toMatch(/(^|\s)xl:flex(\s|$)/)
    expect(picker.className).toContain('max-w-[10rem]')
    expect(picker.className).toContain('xl:max-w-[18rem]')
  })

  it('tells apart two runs of the same rules taken in the same minute', async () => {
    // Labelled to the minute, they were two identical rows.
    vi.spyOn(api, 'listBacktests').mockResolvedValue([
      RUN,
      { ...RUN, id: 'run-2', created_at: RUN.created_at + 10_000 },
    ])
    renderBar()
    const picker = await screen.findByRole('combobox', { name: /run/i })
    await screen.findAllByRole('option', { name: /default rules/ })

    const runs = within(picker)
      .getAllByRole('option')
      .filter((option) => option.getAttribute('value'))
      .map((option) => option.textContent)
    expect(runs).toHaveLength(2)
    expect(new Set(runs).size).toBe(2)
  })
})
