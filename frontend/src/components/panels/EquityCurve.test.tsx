import { render, screen } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'
import { expect, it, vi } from 'vitest'
import { EquityCurve } from './EquityCurve'

const seen = vi.hoisted(() => ({
  chart: [] as Array<Record<string, unknown>>,
  xAxis: [] as Array<Record<string, unknown>>,
  yAxis: [] as Array<Record<string, unknown>>,
}))

vi.mock('recharts', async () => {
  const { cloneElement } = await import('react')
  const container = ({ children }: { children: ReactNode }) => <div>{children}</div>
  return { ResponsiveContainer: container,
    AreaChart: (props: { children: ReactNode }) => {
      seen.chart.push(props)
      return <svg>{props.children}</svg>
    },
    Area: () => null, CartesianGrid: () => null, ReferenceLine: () => null,
    XAxis: (props: Record<string, unknown>) => {
      seen.xAxis.push(props)
      return null
    },
    YAxis: (props: Record<string, unknown>) => {
      seen.yAxis.push(props)
      return null
    },
    Tooltip: ({ content }: { content: ReactElement }) => cloneElement(content, {
      active: true, payload: [{ payload: { trade_number: 2, equity: -5, drawdown: -7.25, time: 1 } }],
    } as Record<string, unknown>) }
})

it('shows the signed peak-to-trough drawdown in the tooltip', () => {
  render(<EquityCurve points={[{ trade_number: 2, equity: 95, drawdown: -7.25, time: 1 }]} />)
  expect(screen.getByText('-7.25%')).toBeInTheDocument()
})

it('keeps the axis labels inside the chart, minus signs included', () => {
  seen.chart.length = 0
  render(<EquityCurve points={[{ trade_number: 1, equity: 98.8, drawdown: -1.2, time: 1 }]} />)
  const margin = seen.chart.at(-1)?.margin as { left: number }
  expect(margin.left).toBeGreaterThanOrEqual(0)
})

it('counts trades along the axis in the order they closed', () => {
  // Trade 3 closed before trade 2. The axis is the count of closed trades;
  // the number is kept for the tooltip, which names the row in the table.
  seen.chart.length = 0
  seen.xAxis.length = 0
  render(<EquityCurve points={[
    { trade_number: 1, equity: 90, drawdown: -10, time: 3 },
    { trade_number: 3, equity: 81, drawdown: -19, time: 4 },
    { trade_number: 2, equity: 97.2, drawdown: -2.8, time: 5 },
  ]} />)
  const data = seen.chart.at(-1)?.data as Array<{ closed: number; trade_number: number }>
  expect(seen.xAxis.at(-1)?.dataKey).toBe('closed')
  expect(data.map((point) => point.closed)).toEqual([0, 1, 2, 3])
  expect(data.map((point) => point.trade_number)).toEqual([0, 1, 3, 2])
})
