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

import { useEffect, useRef, useState } from 'react'
import { ChevronUp, SlidersHorizontal, Radar, X } from 'lucide-react'
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
import { NARROW_QUERY, useMediaQuery } from '@/hooks/useMediaQuery'
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

  /**
   * Below this width the panel cannot share the row with a chart -- a split
   * that reads as 78/22 on a laptop leaves the candles about fifty pixels on
   * a phone. So it stops being a column and becomes a sheet over the chart,
   * closed until asked for. The rail that opens it never moves either way.
   */
  const narrow = useMediaQuery(NARROW_QUERY)
  // What was open when the window got too narrow for it, so that widening
  // the window again puts back the panel it took away rather than leaving
  // the user to work out where it went.
  const displaced = useRef<SidebarTab | null>(null)
  // The latest tab, readable from an effect that must not re-run when it
  // changes. Recording it inside the `setTab` updater instead would be a
  // side effect in a function React is free to call twice -- and does, in
  // development, which is how it came to be read back as null.
  const tabRef = useRef(tab)
  tabRef.current = tab

  useEffect(() => {
    if (narrow) {
      displaced.current = tabRef.current
      setTab(null)
      return
    }
    const restore = displaced.current
    displaced.current = null
    if (restore) setTab(restore)
  }, [narrow])

  const dockedPanel = tab != null && !narrow
  const sheetPanel = tab != null && narrow

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <TopBar />

      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ToolRail />

        {/*
         * `min-w-0` is what keeps the rail on the right of the screen.
         * A flex item's automatic minimum is its *content's* minimum, and a
         * chart pane's is wide -- legend, price axis, the lot -- so without
         * this the row refuses to shrink below about 840px, overflows a
         * narrower window and pushes the panel rail out past its edge.
         */}
        <div className="flex min-h-0 min-w-0 flex-1">
          <main
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            style={dockedPanel ? { flex: `${sidebarRatio} 1 0%` } : undefined}
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

          {dockedPanel && (
            <>
              <Splitter
                direction="row"
                ratio={sidebarRatio}
                onRatioChange={setSidebarRatio}
                min={0.45}
                max={0.9}
                label="Resize the side panel"
              />
              {/*
               * A floor under the panel width, because the split is a
               * *ratio*: on a laptop 22% is a comfortable column, on a
               * tablet it is 170px and every row in it is clipped mid-word.
               * Below the floor the panel is worth closing, not shrinking --
               * and the rail beside it is how you close it.
               */}
              <aside
                className="panel min-h-0 w-full min-w-[15rem] overflow-hidden"
                style={{ flex: `${1 - sidebarRatio} 1 0%` }}
              >
                {tab === 'analysis' ? <AnalysisPanel /> : <StrategyPanel />}
              </aside>
            </>
          )}
        </div>

        {/* The same panel, over the chart rather than beside it. */}
        {sheetPanel && (
          <aside
            className="panel absolute inset-y-0 right-10 z-40 flex w-[min(22rem,calc(100%-5rem))] flex-col overflow-hidden border-l border-border shadow-2xl"
            aria-label={tab === 'analysis' ? 'Analysis' : 'Strategy'}
          >
            <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2">
              <span className="label-caps">{tab === 'analysis' ? 'Analysis' : 'Strategy'}</span>
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5"
                onClick={() => setTab(null)}
                title="Close the panel"
                aria-label="Close the panel"
              >
                <X size={12} />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              {tab === 'analysis' ? <AnalysisPanel /> : <StrategyPanel />}
            </div>
          </aside>
        )}

        {/*
         * The rail stays put whether the panel beside it is open or shut, so
         * the way back is always in the same place -- which is the whole
         * reason a rail exists rather than a row of tabs that vanishes with
         * the panel it labels.
         */}
        <nav
          aria-label="Side panels"
          className="panel flex w-10 shrink-0 flex-col items-center gap-1 overflow-y-auto border-l border-border py-1.5"
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
