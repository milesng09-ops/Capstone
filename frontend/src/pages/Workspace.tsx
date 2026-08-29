/**
 * The whole application on one screen.
 *
 * The shell is flush: bars top and bottom, rails down both edges, and panes
 * that butt up against each other with a hairline between them. Nothing is
 * inset in a floating card, because on a chart screen every pixel of padding
 * is a pixel of price you cannot see -- and because the layout is read as one
 * instrument, not as a page of separate widgets.
 *
 * Reading outward from the candles: the drawing tools are on the left edge
 * they act on, what is charted is along the top, the settings that drive a
 * backtest are on the right, the results it produced are underneath, and the
 * bottom strip holds how much history is loaded and the disclaimer.
 *
 * Both interior divisions are draggable. How much room the results deserve
 * against the chart, and the chart against the settings, is a question about
 * what you are doing right now, so it is answered at the divider rather than
 * fixed here.
 */

import { useState } from 'react'
import { ChevronUp, SlidersHorizontal, Radar } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { ChartGrid } from '@/components/chart/ChartGrid'
import { ToolRail } from '@/components/chart/ToolRail'
import { Splitter } from '@/components/layout/Splitter'
import { StatusBar } from '@/components/layout/StatusBar'
import { TopBar } from '@/components/layout/TopBar'
import { AnalysisPanel } from '@/components/panels/AnalysisPanel'
import { ResultsPanel } from '@/components/panels/ResultsPanel'
import { StrategyPanel } from '@/components/panels/StrategyPanel'
import { Button } from '@/components/ui/primitives'
import { cn } from '@/utils/cn'

type SidebarTab = 'analysis' | 'strategy'

const SIDEBAR_TABS: { value: SidebarTab; label: string; icon: LucideIcon; hint: string }[] = [
  {
    value: 'strategy',
    label: 'Strategy',
    icon: SlidersHorizontal,
    hint: 'The selected setup, the rules to trade it by, and the run button',
  },
  {
    value: 'analysis',
    label: 'Analysis',
    icon: Radar,
    hint: 'ICT detector settings and what they found on the primary chart',
  },
]

export function Workspace() {
  const [tab, setTab] = useState<SidebarTab | null>('strategy')
  const [resultsOpen, setResultsOpen] = useState(true)
  const [sidebarRatio, setSidebarRatio] = useState(0.78)
  const [chartRatio, setChartRatio] = useState(0.58)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <ToolRail />

        <div className="flex min-h-0 flex-1">
          <main
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            style={tab ? { flex: `${sidebarRatio} 1 0%` } : undefined}
          >
            <div
              className="flex min-h-0 flex-1"
              style={resultsOpen ? { flex: `${chartRatio} 1 0%` } : undefined}
            >
              <ChartGrid />
            </div>

            {resultsOpen ? (
              <>
                <Splitter
                  direction="column"
                  ratio={chartRatio}
                  onRatioChange={setChartRatio}
                  min={0.25}
                  max={0.9}
                  label="Resize the results"
                />
                <section
                  className="panel relative min-h-0"
                  style={{ flex: `${1 - chartRatio} 1 0%` }}
                >
                  <Button
                    size="icon"
                    variant="ghost"
                    className="absolute right-1.5 top-1.5 z-20 h-6 w-6"
                    onClick={() => setResultsOpen(false)}
                    title="Collapse the results"
                    aria-label="Collapse the results"
                  >
                    <ChevronUp size={14} />
                  </Button>
                  <ResultsPanel />
                </section>
              </>
            ) : (
              <button
                type="button"
                onClick={() => setResultsOpen(true)}
                className="panel flex h-7 shrink-0 items-center gap-2 border-t border-border px-2 text-left hover:bg-[hsl(var(--panel-raised))]"
                title="Show the results"
              >
                <span className="label-caps">Results</span>
                <ChevronUp size={13} className="ml-auto text-muted-foreground" />
              </button>
            )}
          </main>

          {tab && (
            <>
              <Splitter
                direction="row"
                ratio={sidebarRatio}
                onRatioChange={setSidebarRatio}
                min={0.45}
                max={0.9}
                label="Resize the side panel"
              />
              <aside
                className="panel min-h-0 min-w-0 overflow-hidden"
                style={{ flex: `${1 - sidebarRatio} 1 0%` }}
              >
                {tab === 'analysis' ? <AnalysisPanel /> : <StrategyPanel />}
              </aside>
            </>
          )}
        </div>

        {/*
         * The rail stays put whether the panel beside it is open or shut, so
         * the way back is always in the same place -- which is the whole
         * reason a rail exists rather than a row of tabs that vanishes with
         * the panel it labels.
         */}
        <nav
          aria-label="Side panels"
          className="panel flex w-10 shrink-0 flex-col items-center gap-1 border-l border-border py-1.5"
        >
          {SIDEBAR_TABS.map((item) => {
            const active = tab === item.value
            const Icon = item.icon
            return (
              <button
                key={item.value}
                type="button"
                onClick={() => setTab(active ? null : item.value)}
                title={active ? `Hide ${item.label} — ${item.hint}` : item.hint}
                aria-pressed={active}
                className={cn(
                  'flex w-8 flex-col items-center gap-1.5 rounded py-2 transition-colors',
                  active
                    ? 'bg-primary/15 text-foreground'
                    : 'text-muted-foreground hover:bg-secondary hover:text-foreground',
                )}
              >
                <Icon size={15} />
                <span className="text-2xs tracking-wide [writing-mode:vertical-rl]">
                  {item.label}
                </span>
              </button>
            )
          })}
        </nav>
      </div>

      <StatusBar />
    </div>
  )
}
