/**
 * Cumulative return, trade by trade.
 *
 * Design notes, because they were decisions rather than defaults:
 *
 * *One series, one hue.* Equity is a single measure over time, so it gets one
 * accent line against a baseline at zero -- not a green/red split. Break-even
 * is the thing you compare against, so it is drawn as the reference line.
 *
 * *No dual axis.* Drawdown is deliberately not layered on a second scale. It
 * is already in the tiles above, and a second y-axis is the fastest way to
 * make two unrelated shapes look correlated.
 *
 * *Never colour alone.* Green and red separate by only ΔE 8.3 under
 * deuteranopia, which is a hair over the legibility floor, so every value in
 * this panel carries its sign and a word as well as a colour.
 */

import { useMemo } from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'

import { readChartPalette } from '@/lib/chart'
import type { EquityPoint } from '@/types/backtest'
import { formatDateTime, formatPercent } from '@/utils/format'

export function EquityCurve({ points }: { points: EquityPoint[] }) {
  const palette = useMemo(() => readChartPalette(), [])

  if (points.length === 0) {
    return (
      <div className="grid h-full place-items-center text-2xs text-muted-foreground">
        No trades were taken, so there is no equity curve to draw.
      </div>
    )
  }

  // Anchor the curve at zero so the first trade's move is visible rather than
  // being the whole line.
  const data = [
    { trade_number: 0, equity: 0, drawdown: 0, time: points[0].time },
    ...points,
  ]

  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -18 }}>
        <defs>
          <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={palette.accent} stopOpacity={0.35} />
            <stop offset="100%" stopColor={palette.accent} stopOpacity={0.02} />
          </linearGradient>
        </defs>

        <CartesianGrid stroke={palette.grid} strokeDasharray="3 3" vertical={false} />

        <XAxis
          dataKey="trade_number"
          tick={{ fill: palette.muted, fontSize: 10 }}
          tickLine={false}
          axisLine={{ stroke: palette.border }}
          minTickGap={24}
        />
        <YAxis
          tick={{ fill: palette.muted, fontSize: 10 }}
          tickLine={false}
          axisLine={false}
          width={46}
          tickFormatter={(value: number) => `${value.toFixed(1)}%`}
        />

        {/* Break-even: the line every equity curve is judged against. */}
        <ReferenceLine y={0} stroke={palette.muted} strokeDasharray="4 4" />

        <Tooltip
          cursor={{ stroke: palette.accent, strokeWidth: 1, strokeDasharray: '3 3' }}
          content={<EquityTooltip />}
        />

        <Area
          type="monotone"
          dataKey="equity"
          stroke={palette.accent}
          strokeWidth={2}
          fill="url(#equityFill)"
          dot={false}
          activeDot={{ r: 4, strokeWidth: 0 }}
          isAnimationActive={false}
          name="Cumulative return"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}

interface TooltipPayload {
  payload?: EquityPoint & { trade_number: number }
}

function EquityTooltip({
  active,
  payload,
}: {
  active?: boolean
  payload?: TooltipPayload[]
}) {
  const point = payload?.[0]?.payload
  if (!active || !point) return null

  return (
    <div className="rounded-md border border-border bg-[hsl(var(--popover))] px-2.5 py-1.5 shadow-lg">
      <p className="text-2xs font-medium">
        {point.trade_number === 0 ? 'Start' : `Trade ${point.trade_number}`}
      </p>
      <p className="numeric text-2xs text-muted-foreground">
        Cumulative <span className="text-foreground">{formatPercent(point.equity)}</span>
      </p>
      {point.drawdown > 0 && (
        <p className="numeric text-2xs text-muted-foreground">
          Drawdown <span className="text-bear">-{point.drawdown.toFixed(2)}%</span>
        </p>
      )}
      {point.time > 0 && (
        <p className="numeric mt-0.5 text-2xs text-muted-foreground">
          {formatDateTime(point.time)}
        </p>
      )}
    </div>
  )
}
