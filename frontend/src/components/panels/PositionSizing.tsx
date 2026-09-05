/**
 * What this setup costs and pays, in money.
 *
 * The engine answers in percentages and sizes nothing, which is correct for
 * measuring a rule and no help at all in judging whether you would take the
 * trade. "Down 1.04% if it fails" and "down $1,000 if it fails" are the same
 * fact and they are not read the same way.
 *
 * The size is derived backwards from the loss: rather than picking a position
 * and discovering what it risks, the risk budget is fixed and the size falls
 * out of it. So the estimated loss always equals the budget exactly -- that is
 * not a coincidence to be explained away, it is the definition of sizing to
 * risk, and seeing it hold is how you know the number is doing its job.
 *
 * Nothing here is sent to the backend.
 */

import { useMemo } from 'react'

import { NumberField, SegmentedControl } from '@/components/ui/fields'
import { useWorkspace } from '@/store/workspace'
import { RISK_PRESETS } from '@/types/backtest'
import type { Candle } from '@/types/market'
import { planPosition, resolveLevels, type SetupWindow } from '@/lib/sizing'
import { cn } from '@/utils/cn'
import { formatCurrency, formatNumber, formatPercent, formatPrice } from '@/utils/format'

interface Props {
  candles: Candle[]
  /** The selected candles, or null while nothing is selected. */
  setup: SetupWindow | null
  precision?: number
}

export function PositionSizing({ candles, setup, precision = 2 }: Props) {
  const rules = useWorkspace((state) => state.rules)
  const sizing = useWorkspace((state) => state.sizing)
  const updateSizing = useWorkspace((state) => state.updateSizing)

  const outcome = useMemo(() => {
    if (!setup || candles.length === 0) return null

    const levels = resolveLevels(candles, setup, rules)
    if (!levels.ok) return { problem: levels.problem }

    const plan = planPosition(
      levels.levels,
      rules,
      sizing.accountEquity,
      sizing.riskPercent,
    )
    return plan.ok ? { plan: plan.plan } : { problem: plan.problem }
  }, [candles, setup, rules, sizing.accountEquity, sizing.riskPercent])

  // The risk budget stands on its own: it needs no setup, no levels and no
  // plan, only the two fields beside it.
  const riskAmount = (sizing.accountEquity * sizing.riskPercent) / 100

  // A stop drawn from the pattern's own high or low, or from its ATR, is a
  // different distance for every match the search finds. A percentage stop is
  // the same distance every time. That difference decides whether these
  // figures describe one trade or the whole run, so it is stated rather than
  // left for the reader to work out.
  const stopVariesPerMatch =
    rules.stop_loss_type === 'pattern_extreme' || rules.stop_loss_type === 'atr_multiple'

  const plan = outcome && 'plan' in outcome ? outcome.plan : null

  return (
    <section className="space-y-2 border-t border-border pt-2.5">
      <span className="label-caps">Position sizing</span>

      <div className="grid grid-cols-2 gap-2">
        <Estimate
          label="Estimated loss"
          value={plan ? -plan.estimatedLoss : null}
          percent={plan?.stopReturnPercent}
          tone="bear"
          hint="What a stop-out costs, after fees and slippage. Equal to the risk budget by construction."
        />
        <Estimate
          label="Estimated profit"
          value={plan?.estimatedProfit ?? null}
          percent={plan?.targetReturnPercent}
          tone={plan && plan.estimatedProfit < 0 ? 'bear' : 'bull'}
          hint="What the target pays, after fees and slippage."
        />
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="flex items-baseline gap-1.5">
          <span className="label-caps">Risk</span>
          {/*
           * The budget in money, beside the percentage that sets it. Both are
           * the same fact, and "2%" is the one nobody reads as an amount --
           * it is the figure the estimated loss above has to match, so it is
           * shown rather than left to be multiplied out. Derived from the two
           * fields directly, so it stands with no setup selected too.
           */}
          <span
            className="numeric text-2xs text-muted-foreground"
            title={`${formatNumber(sizing.riskPercent, 2)}% of ${formatCurrency(
              sizing.accountEquity,
              0,
            )} — what one stop-out is allowed to cost`}
          >
            {formatCurrency(riskAmount, 0)}
          </span>
        </span>
        <SegmentedControl<string>
          variant="plain"
          value={String(sizing.riskPercent)}
          options={RISK_PRESETS.map((percent) => ({
            value: String(percent),
            label: `${percent}%`,
            title: `Risk ${percent}% of the account on this trade`,
          }))}
          onChange={(value) => updateSizing({ riskPercent: Number(value) })}
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label="Account"
          hint="Equity the risk percentage is taken from. Never leaves the browser."
          value={sizing.accountEquity}
          min={0}
          step={1000}
          suffix="USD"
          onChange={(accountEquity) => updateSizing({ accountEquity })}
        />
        <NumberField
          label="Risk"
          hint="Share of the account a single stop-out may cost"
          value={sizing.riskPercent}
          min={0}
          max={100}
          step={0.05}
          suffix="%"
          onChange={(riskPercent) => updateSizing({ riskPercent })}
        />
      </div>

      {!setup ? (
        <p className="text-2xs leading-relaxed text-muted-foreground">
          Select a setup on the chart to price it.
        </p>
      ) : outcome && 'problem' in outcome ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-2xs leading-relaxed text-amber-300">
          {outcome.problem}
        </p>
      ) : plan ? (
        <>
          <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 rounded-md border border-border bg-[hsl(var(--panel-raised))] p-2.5 text-2xs">
            <Row label="Entry" value={formatPrice(plan.levels.entry, precision)} />
            <Row label="Stop" value={formatPrice(plan.levels.stop, precision)} />
            <Row label="Target" value={formatPrice(plan.levels.target, precision)} />
            <Row label="Reward / risk" value={`${formatNumber(plan.rewardToRisk, 2)}x`} />
            <Row label="Size" value={`${formatNumber(plan.units, 3)} units`} />
            <Row label="Notional" value={formatCurrency(plan.notional, 0)} />
          </div>

          <p className="text-2xs leading-relaxed text-muted-foreground">
            The engine reports percentage returns and does not use position size; these
            figures scale one trade at {formatNumber(sizing.riskPercent, 2)}% risk.{' '}
            {stopVariesPerMatch
              ? 'This stop is measured from the selected window, so every historical match will size differently.'
              : 'Every match uses the same percentage stop, so these figures apply to each simulated trade.'}
          </p>
        </>
      ) : null}
    </section>
  )
}

function Estimate({
  label,
  value,
  percent,
  tone,
  hint,
}: {
  label: string
  value: number | null
  percent?: number
  tone: 'bull' | 'bear'
  hint: string
}) {
  return (
    <div
      title={hint}
      className={cn(
        'rounded-md border p-2.5',
        tone === 'bull' ? 'border-bull/30 bg-bull/10' : 'border-bear/30 bg-bear/10',
      )}
    >
      <p className="label-caps truncate">{label}</p>
      <p
        className={cn(
          'numeric mt-0.5 text-base font-semibold leading-none',
          tone === 'bull' ? 'text-bull' : 'text-bear',
        )}
      >
        {value == null ? '--' : formatCurrency(value)}
      </p>
      <p className="numeric mt-1 text-2xs text-muted-foreground">
        {percent == null ? ' ' : formatPercent(percent)}
      </p>
    </div>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className="numeric">{value}</span>
    </div>
  )
}
