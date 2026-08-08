/**
 * The whole application on one screen.
 *
 * Charts on the left, settings on the right, results underneath. Stacked
 * correlated charts and a single primary chart to select on -- the layout
 * follows the workflow: look, mark, test, read the win rate.
 */

import { useState } from 'react'
import { ChevronDown } from 'lucide-react'

import { ChartGrid } from '@/components/chart/ChartGrid'
import { ChartToolbar } from '@/components/chart/ChartToolbar'
import { AppHeader } from '@/components/layout/AppHeader'
import { AnalysisPanel } from '@/components/panels/AnalysisPanel'
import { ResultsPanel } from '@/components/panels/ResultsPanel'
import { StrategyPanel } from '@/components/panels/StrategyPanel'
import { SegmentedControl } from '@/components/ui/fields'
import { Button } from '@/components/ui/primitives'
import { TOOL_HINTS } from '@/types/drawing'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/utils/cn'

type SidebarTab = 'analysis' | 'strategy'

const SIDEBAR_TABS: { value: SidebarTab; label: string }[] = [
  { value: 'analysis', label: 'Analysis' },
  { value: 'strategy', label: 'Strategy' },
]

export function Workspace() {
  const [tab, setTab] = useState<SidebarTab>('strategy')
  const [resultsOpen, setResultsOpen] = useState(true)
  const tool = useWorkspace((state) => state.tool)

  return (
    <div className="flex h-full flex-col gap-2 p-2">
      <AppHeader />
      <ChartToolbar />

      {tool !== 'cursor' && (
        <p className="rounded-md border border-primary/30 bg-primary/10 px-3 py-1.5 text-2xs text-foreground">
          {TOOL_HINTS[tool]}
        </p>
      )}

      <div className="flex min-h-0 flex-1 gap-2">
        <div className="flex min-h-0 flex-1 flex-col gap-2">
          <ChartGrid />

          <section
            className={cn(
              'panel flex shrink-0 flex-col overflow-hidden rounded-lg transition-[height]',
              resultsOpen ? 'h-[42%] min-h-[16rem]' : 'h-9',
            )}
          >
            {resultsOpen ? (
              <div className="relative min-h-0 flex-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute right-1.5 top-1.5 z-20 h-6 w-6"
                  onClick={() => setResultsOpen(false)}
                  title="Collapse results"
                  aria-label="Collapse results"
                >
                  <ChevronDown size={14} />
                </Button>
                <ResultsPanel />
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setResultsOpen(true)}
                className="flex h-9 w-full items-center gap-2 px-3 text-left"
              >
                <span className="label-caps">Results</span>
                <ChevronDown size={14} className="ml-auto rotate-180 text-muted-foreground" />
              </button>
            )}
          </section>
        </div>

        <aside className="panel flex w-[21rem] shrink-0 flex-col overflow-hidden rounded-lg">
          <div className="flex h-9 shrink-0 items-center border-b border-border px-2">
            <SegmentedControl<SidebarTab>
              value={tab}
              options={SIDEBAR_TABS}
              onChange={setTab}
              size="md"
            />
          </div>
          <div className="min-h-0 flex-1">
            {tab === 'analysis' ? <AnalysisPanel /> : <StrategyPanel />}
          </div>
        </aside>
      </div>

      <footer className="px-1 text-2xs leading-relaxed text-muted-foreground">
        Educational and research use only. Historical results do not guarantee future
        performance, and a backtest measures a rule against the past, not the market you will
        actually trade.
      </footer>
    </div>
  )
}
