/**
 * The one bar across the top: what you are looking at, at what resolution,
 * where the data came from, and which saved run is on screen.
 *
 * Everything that changes *what is charted* lives here, on a single 36px row,
 * the way a trading terminal does it -- symbol, then interval, then the
 * correlated markets charted alongside. The drawing tools deliberately do not:
 * they are a different kind of verb, they are held rather than picked, and
 * they belong next to the candles they act on. They live in the left rail.
 *
 * Provider state is surfaced here rather than buried in settings because it
 * changes what the numbers mean. A win rate computed on synthetic demo data
 * and one computed on real futures prices look identical, so the difference
 * has to be visible without being asked for.
 */

import { Activity, Columns3, Database, LayoutGrid, Rows3 } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { SegmentedControl } from '@/components/ui/fields'
import { Badge, Button, Spinner } from '@/components/ui/primitives'
import { useBacktestHistory } from '@/hooks/useBacktest'
import { useProviderStatus } from '@/hooks/useMarketData'
import {
  useChartedSymbols,
  useTimeZone,
  useWorkspace,
  type ChartLayout,
} from '@/store/workspace'
import {
  INTERVAL_LABELS,
  INTERVALS,
  PROVIDER_LABELS,
  SYMBOLS,
  type Interval,
  type SymbolKey,
} from '@/types/market'
import { formatDateTime, formatNumber } from '@/utils/format'
import type { BacktestListItem } from '@/types/backtest'

export function TopBar() {
  // Timestamps below are drawn in the zone chosen in the status bar;
  // reading it here is what re-renders them when that changes.
  useTimeZone()

  const statusQuery = useProviderStatus()
  const historyQuery = useBacktestHistory()

  const primarySymbol = useWorkspace((state) => state.primarySymbol)
  const compareSymbols = useWorkspace((state) => state.compareSymbols)
  const interval = useWorkspace((state) => state.interval)
  const activeId = useWorkspace((state) => state.activeBacktestId)

  const setPrimarySymbol = useWorkspace((state) => state.setPrimarySymbol)
  const toggleCompareSymbol = useWorkspace((state) => state.toggleCompareSymbol)
  const setInterval = useWorkspace((state) => state.setInterval)
  const setActiveBacktestId = useWorkspace((state) => state.setActiveBacktestId)

  const status = statusQuery.data
  const provider = status?.active_provider
  const isDemo = provider === 'demo'

  // When this verdict was last confirmed with the backend. A badge reading
  // "Demo mode" because the data really is synthetic looks exactly like one
  // reading "Demo mode" because the backend was unreachable at load, so the
  // badge carries its own age and lets you tell the two apart.
  const checkedAt = statusQuery.dataUpdatedAt
    ? `Last confirmed with the backend at ${formatDateTime(statusQuery.dataUpdatedAt)}.`
    : ''

  /*
   * One row on a laptop, two on a phone.
   *
   * The symbols and the intervals alone come to just over 300px, so at 375
   * the provider badge was pushed off the end of a bar that scrolled sideways
   * to reach it. That badge is the one that says whether a win rate came from
   * real prices or from demo candles, and status you have to go looking for
   * is status you will not look for. Wrapping spends about 28px of chart
   * height to keep it in sight; scrolling spent nothing and hid it.
   */
  return (
    <header className="panel flex min-h-9 shrink-0 flex-wrap items-center gap-2 border-b border-border px-2 py-1 min-[600px]:h-9 min-[600px]:flex-nowrap min-[600px]:overflow-x-auto min-[600px]:py-0">
      <div className="flex shrink-0 items-center gap-1.5" title="Market Replay Lab">
        <Activity size={15} className="text-primary" />
        <span className="hidden text-xs font-semibold tracking-tight lg:block">
          Market Replay Lab
        </span>
      </div>

      <span className="bar-divider" />

      <SegmentedControl<SymbolKey>
        variant="plain"
        value={primarySymbol}
        options={SYMBOLS.map((symbol) => ({
          value: symbol,
          label: symbol,
          title: `Chart ${symbol} as the primary market`,
        }))}
        onChange={setPrimarySymbol}
      />

      <span className="bar-divider" />

      <SegmentedControl<Interval>
        variant="plain"
        value={interval}
        options={INTERVALS.map((item) => ({ value: item, label: INTERVAL_LABELS[item] }))}
        onChange={setInterval}
      />

      <span className="bar-divider hidden md:block" />

      <div
        className="hidden shrink-0 items-center gap-1 md:flex"
        title="Correlated markets charted alongside, for SMT divergence"
      >
        <span className="label-caps">vs</span>
        {SYMBOLS.filter((symbol) => symbol !== primarySymbol).map((symbol) => {
          const active = compareSymbols.includes(symbol)
          return (
            <Button
              key={symbol}
              size="sm"
              variant="toolbar"
              data-active={active}
              onClick={() => toggleCompareSymbol(symbol)}
              title={
                active
                  ? `Stop comparing ${primarySymbol} against ${symbol}`
                  : `Chart ${symbol} alongside and check for divergence`
              }
            >
              {symbol}
            </Button>
          )
        })}
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <LayoutPicker />

        {historyQuery.data && historyQuery.data.length > 0 && (
          <label className="hidden items-center gap-1.5 xl:flex">
            <span className="label-caps">Run</span>
            <select
              className="h-6 max-w-[18rem] rounded border border-input bg-[hsl(var(--panel-raised))] px-1.5 text-2xs outline-none focus:border-primary/60"
              value={activeId ?? ''}
              onChange={(event) => setActiveBacktestId(event.target.value || null)}
            >
              <option value="">Latest / none</option>
              {groupBySetup(historyQuery.data).map((group) => (
                <optgroup key={group.key} label={group.title}>
                  {group.runs.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.win_rate != null
                        ? `${formatNumber(item.win_rate, 0)}%`
                        : item.status}
                      {' · '}
                      {item.label || 'default rules'}
                      {' · '}
                      {formatDateTime(item.created_at)}
                    </option>
                  ))}
                </optgroup>
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
              title={[
                isDemo
                  ? 'Bundled synthetic data generated from a fixed seed. Not real market prices.'
                  : status.fallback_reason ?? `Serving data from ${provider}`,
                checkedAt,
              ]
                .filter(Boolean)
                .join(' ')}
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
                className="hidden lg:inline-flex"
                title={`Set MASSIVE_API_KEY in the backend .env to use live market data. ${checkedAt}`.trim()}
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

/**
 * How the charted markets are arranged against each other.
 *
 * Hidden while only one market is charted, where every arrangement is the
 * same picture and three buttons that do nothing are worse than none.
 */
function LayoutPicker() {
  const layout = useWorkspace((state) => state.chartLayout)
  const setChartLayout = useWorkspace((state) => state.setChartLayout)
  const count = useChartedSymbols().length

  if (count < 2) return null

  const options: { value: ChartLayout; icon: LucideIcon; title: string }[] = [
    {
      value: 'stacked',
      icon: Rows3,
      title: 'Stack the charts, one above the other — the arrangement divergence is read in',
    },
    {
      value: 'columns',
      icon: Columns3,
      title: 'Set the charts side by side, each with the full height of the screen',
    },
    {
      value: 'grid',
      icon: LayoutGrid,
      title: 'Primary across the top, the markets it is compared against beneath it',
    },
  ]

  return (
    /*
     * Gone below 600px, where the grid forces everything to stack anyway: a
     * control that cannot change what you are looking at is worse than no
     * control, and these three were the first things pushed off the end of a
     * 375px header. They come back with the width that makes them mean
     * something.
     */
    <div
      className="hidden items-center gap-px min-[600px]:flex"
      role="group"
      aria-label="Chart layout"
    >
      {options.map(({ value, icon: Icon, title }) => (
        <Button
          key={value}
          size="icon"
          variant="toolbar"
          className="h-7 w-7"
          data-active={layout === value}
          onClick={() => setChartLayout(value)}
          title={title}
          aria-label={title}
          aria-pressed={layout === value}
        >
          <Icon size={14} />
        </Button>
      ))}
    </div>
  )
}


/**
 * Runs gathered under the setup they were testing.
 *
 * A flat list of every run is unreadable once you have tried a few things:
 * forty rows of "ES 1h - 28% win" differ only in a timestamp, and the one
 * question worth asking of the list -- what did I already try against *this*
 * window, and what did it give me -- cannot be answered from it at all.
 *
 * Grouping by the selection answers it directly, and it is the same unit the
 * backend counts configurations against, so the list and the family-wise
 * p-value are talking about the same thing.
 *
 * Groups keep the order their newest run appeared in, so the most recent work
 * stays at the top rather than being reordered by setup date.
 */
function groupBySetup(items: BacktestListItem[]) {
  const groups = new Map<string, { key: string; title: string; runs: BacktestListItem[] }>()

  for (const item of items) {
    const key = `${item.primary_symbol}|${item.interval}|${item.selection_start}|${item.selection_end}`
    const existing = groups.get(key)
    if (existing) {
      existing.runs.push(item)
      continue
    }
    groups.set(key, {
      key,
      title: item.selection_start
        ? `${item.primary_symbol} ${item.interval} · setup ${formatDateTime(item.selection_start)}`
        : `${item.primary_symbol} ${item.interval}`,
      runs: [item],
    })
  }

  return [...groups.values()]
}
