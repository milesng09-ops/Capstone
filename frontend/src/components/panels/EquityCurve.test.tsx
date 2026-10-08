import { render, screen } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { EquityCurve } from './EquityCurve'

vi.mock('recharts', async () => {
  const { cloneElement } = await import('react')
  const container = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return { ResponsiveContainer: container,
    AreaChart: ({ children }: { children: ReactNode }) => <svg>{children}</svg>,
    Area: () => null, CartesianGrid: () => null, ReferenceLine: () => null,
    XAxis: () => null, YAxis: () => null,
    Tooltip: ({ content }: { content: ReactElement }) => cloneElement(content, {
      active: true, payload: [{ payload: { trade_number: 2, equity: -5, drawdown: -7.25, time: 1 } }],
    } as Record<string, unknown>) }
})

it('shows the signed peak-to-trough drawdown in the tooltip', () => {
  render(<EquityCurve points={[{ trade_number: 2, equity: 95, drawdown: -7.25, time: 1 }]} />)
  expect(screen.getByText('-7.25%')).toBeInTheDocument()
})
