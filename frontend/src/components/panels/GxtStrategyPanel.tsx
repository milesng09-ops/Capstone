import { CalendarRange, Play } from 'lucide-react'

import { NumberField, SelectField, ToggleField } from '@/components/ui/fields'
import { Button, Disclosure, Spinner } from '@/components/ui/primitives'
import { buildGxtRequest, effectiveLookbackDays, useRunBacktest } from '@/hooks/useBacktest'
import { useChartRange } from '@/hooks/useChartRange'
import { useChartedSymbols, useTimeZone, useWorkspace } from '@/store/workspace'
import { formatDateTime } from '@/utils/format'

export function GxtStrategyPanel() {
  useTimeZone()
  const range = useChartRange()
  const symbols = useChartedSymbols()
  const state = useWorkspace()
  const run = useRunBacktest()
  const { gxt, rules, search, testWindow } = state
  const supported = ['1m', '2m', '3m', '5m', '15m', '30m', '1h'].includes(state.interval)
  const missingReference = gxt.require_cross_asset && symbols.length < 2
  const start =
    testWindow?.start_time ??
    range.to - effectiveLookbackDays(search.lookbackDays, state.interval) * 86_400_000
  const end = testWindow?.end_time ?? range.to

  const submit = () => {
    const request = buildGxtRequest({
      primarySymbol: state.primarySymbol, symbols, interval: state.interval,
      rules, search, gxt, rangeEnd: range.to, testWindow,
    })
    run.mutate(request, { onSuccess: (result) => {
      state.setActiveBacktestId(result.id)
      state.setShowTrades(true)
      state.setResultsOpen(true)
    } })
  }

  return (
    <div className="flex h-full min-h-0 flex-col p-3">
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <p className="rounded border border-amber-500/30 bg-amber-500/10 p-2 text-2xs leading-relaxed">
          Experimental rules, not a trained GXT network. This tests a 4H sweep/reclaim
          hypothesis; Garrett’s full Universal Sequence, PSP and Strength Switch are
          not yet verified or implemented.
        </p>
        <ol className="list-decimal space-y-1 pl-4 text-2xs text-muted-foreground">
          <li>Wait for C2 to sweep one side of C1 and close back inside, with its body pointing toward reversal.</li>
          <li>Optionally require another market not to sweep that side at the same 4H timestamps.</li>
          <li>Wait for a new three-candle displacement gap on the chart timeframe after C2 closes.</li>
          <li>Enter next open. Stop beyond C2; target the opposite C1 extreme. Skip insufficient reward/risk.</li>
        </ol>
        <p className="text-2xs text-muted-foreground">
          Trade {state.primarySymbol}; compare {symbols.filter(s => s !== state.primarySymbol).join(', ') || 'none'}.
          {' '}4H context is built from complete chart candles on the 18:00 New York session grid.
          One entry attempt per profile; expires before the next 4H close.
        </p>
        <SelectField label="Direction" value={gxt.direction}
          options={[{ value: 'both', label: 'Both' }, { value: 'long', label: 'Long' }, { value: 'short', label: 'Short' }]}
          onChange={(direction) => state.updateGxt({ direction })} />
        <ToggleField label="Require cross-asset sweep divergence" checked={gxt.require_cross_asset}
          hint="All enabled comparisons need matched 4H data; at least one must not sweep the corresponding extreme."
          onChange={(require_cross_asset) => state.updateGxt({ require_cross_asset })} />
        <ToggleField label="Entries only 09:30–11:00 New York" checked={gxt.ny_morning_only}
          onChange={(ny_morning_only) => state.updateGxt({ ny_morning_only })} />
        <div className="grid grid-cols-2 gap-2">
          <NumberField label="Minimum reward/risk" value={gxt.minimum_reward_risk} min={0.1} max={20} step={0.1}
            onChange={(minimum_reward_risk) => state.updateGxt({ minimum_reward_risk })} />
          <NumberField label="Stop buffer (ticks)" value={gxt.stop_buffer_ticks} min={1} max={100}
            onChange={(stop_buffer_ticks) => state.updateGxt({ stop_buffer_ticks })} />
          <NumberField label="Confirmation bars" value={gxt.confirmation_bars} min={3} max={240}
            onChange={(confirmation_bars) => state.updateGxt({ confirmation_bars })} />
          <NumberField label="Min body / range" value={gxt.minimum_body_fraction} min={0} max={1} step={0.05}
            hint="Minimum middle-candle body fraction for the displacement gap."
            onChange={(minimum_body_fraction) => state.updateGxt({ minimum_body_fraction })} />
        </div>
        <Disclosure label="Test window" defaultOpen summary="No example selection needed">
          <p className="text-2xs">{formatDateTime(start)} → {formatDateTime(end)}</p>
          <Button size="sm" variant="secondary" onClick={() => state.setTool('window')}>
            <CalendarRange size={12} /> Draw test window
          </Button>
          {testWindow ? <Button size="sm" variant="ghost" onClick={() => state.setTestWindow(null)}>Use lookback</Button> :
            <NumberField label="Lookback days" value={search.lookbackDays} min={1} max={730}
              onChange={(lookbackDays) => state.updateSearch({ lookbackDays })} />}
          <NumberField label="First signals to test" value={search.maximumMatches} min={1} max={25}
            hint="Earliest signals in time, including signals skipped at entry. Never ranked by their outcome."
            onChange={(maximumMatches) => state.updateSearch({ maximumMatches })} />
        </Disclosure>
        <Disclosure label="Execution costs and holding period" defaultOpen>
          <NumberField label="Maximum holding bars" value={rules.maximum_holding_bars} min={1} max={2000}
            onChange={(maximum_holding_bars) => state.updateRules({ maximum_holding_bars })} />
          <div className="grid grid-cols-2 gap-2">
            <NumberField label="Fees per side (%)" value={rules.fee_percent} min={0} max={5} step={0.01}
              onChange={(fee_percent) => state.updateRules({ fee_percent })} />
            <NumberField label="Slippage (%)" value={rules.slippage_percent} min={0} max={5} step={0.01}
              onChange={(slippage_percent) => state.updateRules({ slippage_percent })} />
          </div>
          <ToggleField label="Allow overlapping trades" checked={rules.allow_overlapping_trades}
            onChange={(allow_overlapping_trades) => state.updateRules({ allow_overlapping_trades })} />
        </Disclosure>
      </div>
      <div className="mt-3 shrink-0 space-y-2 border-t border-border pt-3">
        {!supported && <p className="text-2xs text-amber-300">Choose a supported 1m–1h chart interval (90m is unsupported).</p>}
        {missingReference && <p className="text-2xs text-amber-300">Enable an ES, NQ or YM comparison chart.</p>}
        {run.isError && <p role="alert" className="text-2xs text-bear">{(run.error as Error).message}</p>}
        <Button className="w-full" variant="primary" disabled={!supported || missingReference || run.isPending}
          onClick={submit}>{run.isPending ? <Spinner /> : <Play size={14} />}
          {run.isPending ? 'Testing...' : 'Backtest GXT research'}
        </Button>
      </div>
    </div>
  )
}
