import { act, render } from '@testing-library/react'
import { useEffect } from 'react'
import { beforeEach, expect, it, vi } from 'vitest'

import { ChartGrid } from '@/components/chart/ChartGrid'
import { useWorkspace } from '@/store/workspace'

/**
 * A chart is expensive to lose: its zoom, its scroll position and any shape
 * half drawn on it live in the instance. These count how often each pane is
 * built, which is what a reshuffled tree costs.
 */
const mounts = vi.hoisted(() => ({ count: {} as Record<string, number> }))

vi.mock('@/components/chart/ChartPanel', () => ({
  ChartPanel: ({ symbol }: { symbol: string }) => {
    useEffect(() => {
      mounts.count[symbol] = (mounts.count[symbol] ?? 0) + 1
    }, [symbol])
    return <div data-symbol={symbol} />
  },
}))

beforeEach(() => {
  mounts.count = {}
  act(() => {
    useWorkspace.setState({ primarySymbol: 'NQ', compareSymbols: [], chartLayout: 'stacked' })
  })
})

it('keeps the primary chart when a comparison market is added and removed', () => {
  render(<ChartGrid />)
  act(() => useWorkspace.setState({ compareSymbols: ['ES'] }))
  act(() => useWorkspace.setState({ compareSymbols: [] }))

  expect(mounts.count.NQ).toBe(1)
})

it('keeps every chart when the layout changes', () => {
  act(() => useWorkspace.setState({ compareSymbols: ['ES', 'YM'] }))
  render(<ChartGrid />)
  for (const layout of ['grid', 'columns', 'stacked', 'grid'] as const) {
    act(() => useWorkspace.setState({ chartLayout: layout }))
  }

  expect(mounts.count).toEqual({ NQ: 1, ES: 1, YM: 1 })
})

it('gives the primary the whole top row of the grid, even with one reference', () => {
  act(() => useWorkspace.setState({ compareSymbols: ['ES'], chartLayout: 'grid' }))
  const { container } = render(<ChartGrid />)

  const primary = container.querySelector('[data-symbol="NQ"]')!.closest('.col-span-2')
  const reference = container.querySelector('[data-symbol="ES"]')!.closest('.col-span-2')
  expect(primary).not.toBeNull()
  expect(reference).not.toBeNull()
})
