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

import { useEffect, useState } from 'react'
import { ChevronUp, PanelRightClose, SlidersHorizontal, Radar, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { ChartGrid } from '@/components/chart/ChartGrid'
import { ToolRail } from '@/components/chart/ToolRail'
import { Splitter } from '@/components/layout/Splitter'
import { RateLimitNotice } from '@/components/layout/RateLimitNotice'
import { StatusBar } from '@/components/layout/StatusBar'
import { TopBar } from '@/components/layout/TopBar'
import { AnalysisPanel } from '@/components/panels/AnalysisPanel'
import { ResultsPanel } from '@/components/panels/ResultsPanel'
import { StrategyPanel } from '@/components/panels/StrategyPanel'
import { Button } from '@/components/ui/primitives'
import { CRAMPED_QUERY, NARROW_QUERY, useMediaQuery } from '@/hooks/useMediaQuery'
import { useBacktestResult } from '@/hooks/useBacktest'
import { useWorkspace, type SidePanel } from '@/store/workspace'
import { directionClass, formatInteger, formatNumber, formatPercent } from '@/utils/format'
import { cn } from '@/utils/cn'

const SIDEBAR_TABS: { value: SidePanel; label: string; icon: LucideIcon; hint: string }[] = [
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
  // Held in the store rather than in component state so that a workspace
  // trimmed down to the candles is still trimmed down after a reload. Closing
  // a panel you do not want, every session, is not a preference the app
  // should keep forgetting.
  const tab = useWorkspace((state) => state.sidePanel)
  const setTab = useWorkspace((state) => state.setSidePanel)
  const storedResultsOpen = useWorkspace((state) => state.resultsOpen)
  const setResultsOpen = useWorkspace((state) => state.setResultsOpen)
  const sidebarRatio = useWorkspace((state) => state.sidebarRatio)
  const setSidebarRatio = useWorkspace((state) => state.setSidebarRatio)
  const chartRatio = useWorkspace((state) => state.chartRatio)
  const setChartRatio = useWorkspace((state) => state.setChartRatio)
  const focusMode = useWorkspace((state) => state.focusMode)
  const toggleFocusMode = useWorkspace((state) => state.toggleFocusMode)

  /*
   * "The screen is a bit small" -- from the review call, while collapsing
   * panels one at a time to see more candles. Both already closed
   * individually; what was missing was closing them together and getting
   * them back without having to remember what had been open.
   *
   * F toggles, Escape leaves. Escape only leaves, never enters, so the key
   * that means "get me out of this" cannot put you into something.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const typing =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return

      if (event.key === 'f' || event.key === 'F') {
        event.preventDefault()
        toggleFocusMode()
      } else if (event.key === 'Escape' && useWorkspace.getState().focusMode) {
        toggleFocusMode()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleFocusMode])

  /**
   * Below this width the panel cannot share the row with a chart -- a split
   * that reads as 78/22 on a laptop leaves the candles about fifty pixels on
   * a phone. So it stops being a column and becomes a sheet over the chart,
   * closed until asked for. The rail that opens it never moves either way.
   */
  const narrow = useMediaQuery(NARROW_QUERY)
  /**
   * Which panel the sheet is showing, when there is a sheet.
   *
   * Deliberately *not* the stored choice. Narrowing the window used to write
   * the docked panel away to null, and that null was persisted -- so dragging
   * a window narrow and wide again lost the panel for good, and reopening the
   * app started with it gone. The stored value is the user's answer for a
   * window wide enough to hold a column; the sheet gets its own, transient,
   * one.
   */
  const [sheetTab, setSheetTab] = useState<SidePanel | null>(null)
  /**
   * Narrower still, and two 40px rails are a fifth of the screen spent before
   * a single candle is drawn. So the right-hand rail stops being a column and
   * folds into the left one, which is already there for the drawing tools.
   * One rail, both jobs, forty pixels back for the chart -- and nothing
   * floating over the candles to buy them.
   */
  const cramped = useMediaQuery(CRAMPED_QUERY)
  // Narrowing no longer has to remember and restore anything: the stored
  // choice is simply not consulted while there is no room for a column, and
  // is still there when there is again.
  // Focus hides, it does not close: `tab` and `resultsOpen` keep their stored
  // values so leaving focus puts back the workspace that was there.
  const resultsOpen = storedResultsOpen && !focusMode
  const dockedPanel = tab != null && !narrow && !focusMode
  const sheetPanel = sheetTab != null && narrow

  // One pair of rail buttons drives whichever of the two exists.
  const activePanel = narrow ? sheetTab : tab
  const pickPanel = narrow ? setSheetTab : setTab

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background">
      <TopBar />
      {/*
        Directly under the top bar, above the candles: it qualifies what is
        charted, so it reads before the chart rather than after it. Renders
        nothing at all unless a provider is actually cooling off.
      */}
      <RateLimitNotice />

      <div className="relative flex min-h-0 min-w-0 flex-1">
        <ToolRail
          footer={cramped ? <PanelTabs tab={activePanel} onPick={pickPanel} /> : undefined}
        />

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
              <CollapsedResults onOpen={() => setResultsOpen(true)} />
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
                className="panel relative min-h-0 w-full min-w-[15rem] overflow-hidden"
                style={{ flex: `${1 - sidebarRatio} 1 0%` }}
              >
                {/*
                  The column could always be dismissed by pressing its own lit
                  rail icon, which is not an affordance anyone finds. The
                  results pane has had a chevron on it all along; this is the
                  same control in the same place, so "give the chart the whole
                  width" is one visible click on either.
                */}
                <Button
                  size="icon"
                  variant="ghost"
                  className="absolute right-1.5 top-1.5 z-20 h-6 w-6"
                  onClick={() => setTab(null)}
                  title="Collapse the panel"
                  aria-label="Collapse the panel"
                >
                  <PanelRightClose size={14} />
                </Button>
                {tab === 'analysis' ? <AnalysisPanel /> : <StrategyPanel />}
              </aside>
            </>
          )}
        </div>

        {/* The same panel, over the chart rather than beside it. */}
        {sheetPanel && (
          <aside
            className={cn(
              'panel absolute inset-y-0 z-40 flex w-[min(22rem,calc(100%-5rem))] flex-col overflow-hidden border-l border-border shadow-2xl',
              // Clear of the rail that opens it, so the way back out is never
              // underneath the sheet. Once that rail folds into the left one
              // there is nothing on this edge to clear.
              cramped ? 'right-0' : 'right-10',
            )}
            aria-label={sheetTab === 'analysis' ? 'Analysis' : 'Strategy'}
          >
            <div className="flex h-7 shrink-0 items-center justify-between border-b border-border px-2">
              <span className="label-caps">
                {sheetTab === 'analysis' ? 'Analysis' : 'Strategy'}
              </span>
              <Button
                size="icon"
                variant="ghost"
                className="h-5 w-5"
                onClick={() => setSheetTab(null)}
                title="Close the panel"
                aria-label="Close the panel"
              >
                <X size={12} />
              </Button>
            </div>
            <div className="min-h-0 flex-1">
              {sheetTab === 'analysis' ? <AnalysisPanel /> : <StrategyPanel />}
            </div>
          </aside>
        )}

        {/*
         * The rail stays put whether the panel beside it is open or shut, so
         * the way back is always in the same place -- which is the whole
         * reason a rail exists rather than a row of tabs that vanishes with
         * the panel it labels.
         */}
        {!cramped && (
          <nav
            aria-label="Side panels"
            className="panel flex w-10 shrink-0 flex-col items-center gap-1 overflow-y-auto border-l border-border py-1.5"
          >
            <PanelTabs tab={activePanel} onPick={pickPanel} />
          </nav>
        )}
      </div>

      <StatusBar />
    </div>
  )
}

/**
 * The results pane, shut, still answering the only question that matters.
 *
 * Collapsing it used to leave a strip reading "Results" and nothing else, so
 * the one number the whole exercise exists to produce -- the win rate --
 * was the thing you gave up to see more chart. It fits on one line, so it
 * stays: how many trades, how they split, what fraction won. The detail is a
 * click away; the headline never is.
 */
function CollapsedResults({ onOpen }: { onOpen: () => void }) {
  const activeId = useWorkspace((state) => state.activeBacktestId)
  const { data } = useBacktestResult(activeId)
  const summary = data?.summary

  return (
    <button
      type="button"
      onClick={onOpen}
      className="panel flex h-7 shrink-0 items-center gap-2 border-t border-border px-2 text-left hover:bg-[hsl(var(--panel-raised))]"
      title={summary ? 'Show every trade and the equity curve' : 'Show the results'}
    >
      <span className="label-caps">Results</span>

      {summary && (
        <>
          <span className="numeric text-2xs font-semibold text-foreground">
            {formatNumber(summary.win_rate, 1)}%
          </span>
          <span className="numeric text-2xs text-muted-foreground">
            {formatInteger(summary.trades_executed)} trades
          </span>
          <span className="numeric text-2xs text-muted-foreground">
            {formatInteger(summary.wins)}W / {formatInteger(summary.losses)}L
          </span>
          <span
            className={cn('numeric text-2xs', directionClass(summary.net_return))}
            title="Every trade's return after fees and slippage, compounded"
          >
            {formatPercent(summary.net_return)}
          </span>
        </>
      )}

      <ChevronUp size={13} className="ml-auto shrink-0 text-muted-foreground" />
    </button>
  )
}

/**
 * The way into the side panels: one button per panel, pressed when its panel
 * is showing and pressed again to send it away.
 *
 * Lives in its own component because at a laptop width these sit in the rail
 * on the right, and on a phone the same buttons sit at the foot of the rail
 * on the left. Same control, same behaviour, two homes -- which only works if
 * there is one of it.
 */
function PanelTabs({
  tab,
  onPick,
}: {
  tab: SidePanel | null
  onPick: (next: SidePanel | null) => void
}) {
  return (
    <>
      {SIDEBAR_TABS.map((item) => {
        const active = tab === item.value
        const Icon = item.icon
        return (
          <button
            key={item.value}
            type="button"
            onClick={() => onPick(active ? null : item.value)}
            title={active ? `Hide ${item.label} — ${item.hint}` : item.hint}
            aria-pressed={active}
            className={cn(
              'flex w-8 shrink-0 flex-col items-center gap-1.5 rounded py-2 transition-colors',
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
    </>
  )
}
