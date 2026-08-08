/**
 * Title bar: what you are looking at, where the data came from, and which
 * saved run is on screen.
 *
 * Provider state is surfaced here rather than buried in settings because it
 * changes what the numbers mean. A win rate computed on synthetic demo data
 * and one computed on real futures prices look identical, so the difference
 * has to be visible without being asked for.
 */

import { Activity, Database } from 'lucide-react'

import { Badge, Spinner } from '@/components/ui/primitives'
import { useBacktestHistory } from '@/hooks/useBacktest'
import { useProviderStatus } from '@/hooks/useMarketData'
import { useWorkspace } from '@/store/workspace'
import { PROVIDER_LABELS } from '@/types/market'
import { formatDateTime, formatNumber } from '@/utils/format'

export function AppHeader() {
  const statusQuery = useProviderStatus()
  const historyQuery = useBacktestHistory()
  const activeId = useWorkspace((state) => state.activeBacktestId)
  const setActiveBacktestId = useWorkspace((state) => state.setActiveBacktestId)

  const status = statusQuery.data
  const provider = status?.active_provider
  const isDemo = provider === 'demo'

  return (
    <header className="panel flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg px-3 py-2">
      <div className="flex items-center gap-2">
        <Activity size={15} className="text-primary" />
        <h1 className="text-sm font-semibold tracking-tight">Market Replay Lab</h1>
      </div>

      <p className="hidden text-2xs text-muted-foreground lg:block">
        Mark a setup, test it across history, read the win rate.
      </p>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        {historyQuery.data && historyQuery.data.length > 0 && (
          <label className="flex items-center gap-1.5">
            <span className="label-caps">Run</span>
            <select
              className="h-7 max-w-[16rem] rounded-md border border-input bg-[hsl(var(--panel-raised))] px-2 text-2xs outline-none focus:border-primary/60"
              value={activeId ?? ''}
              onChange={(event) => setActiveBacktestId(event.target.value || null)}
            >
              <option value="">Latest / none</option>
              {historyQuery.data.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.primary_symbol} {item.interval} &middot;{' '}
                  {formatDateTime(item.created_at)}
                  {item.win_rate != null ? ` · ${formatNumber(item.win_rate, 0)}% win` : ''}
                </option>
              ))}
            </select>
          </label>
        )}

        {statusQuery.isLoading ? (
          <Spinner className="text-muted-foreground" />
        ) : statusQuery.isError ? (
          <Badge tone="bear" title={(statusQuery.error as Error).message}>
            backend unreachable
          </Badge>
        ) : status ? (
          <>
            <Badge
              tone={isDemo ? 'warn' : 'bull'}
              title={
                isDemo
                  ? 'Bundled synthetic data generated from a fixed seed. Not real market prices.'
                  : status.fallback_reason ?? `Serving data from ${provider}`
              }
            >
              <Database size={10} />
              {PROVIDER_LABELS[provider ?? ''] ?? provider}
            </Badge>
            {status.fallback_active && (
              <Badge
                tone="warn"
                title={status.fallback_reason ?? 'The preferred provider was unavailable.'}
              >
                fallback
              </Badge>
            )}
            {!status.massive_api_key_configured && (
              <Badge
                tone="neutral"
                title="Set MASSIVE_API_KEY in the backend .env to use live market data."
              >
                no API key
              </Badge>
            )}
          </>
        ) : null}
      </div>
    </header>
  )
}
