/**
 * ICT detector settings and what they found on the primary chart.
 *
 * The divergence list is ordered newest first and states its own validity,
 * because "NQ took the high and ES did not" is only worth acting on when both
 * anchors are meaningful points on the reference chart.
 */

import { Trash2 } from 'lucide-react'

import { NumberField, ToggleField } from '@/components/ui/fields'
import { Badge, Button, EmptyState, Spinner } from '@/components/ui/primitives'
import { useChartRange } from '@/hooks/useChartRange'
import { useIct } from '@/hooks/useMarketData'
import { useChartedSymbols, useWorkspace } from '@/store/workspace'
import { TOOL_LABELS } from '@/types/drawing'
import { VALIDITY_LABELS, VALIDITY_NOTES, type SmtDivergence } from '@/types/ict'
import { cn } from '@/utils/cn'
import { formatDateTime, formatNumber, formatPrice } from '@/utils/format'

export function AnalysisPanel() {
  const range = useChartRange()
  const interval = useWorkspace((state) => state.interval)
  const primary = useWorkspace((state) => state.primarySymbol)
  const settings = useWorkspace((state) => state.ict)
  const updateIct = useWorkspace((state) => state.updateIct)

  const charted = useChartedSymbols()
  const references = charted.filter((symbol) => symbol !== primary)

  const query = useIct(primary, interval, range.from, range.to, references, settings)
  const analysis = query.data

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3">
      <section className="space-y-1">
        <ToggleField
          label="Run detectors"
          hint="Turn off to chart raw candles with no overlays"
          checked={settings.enabled}
          onChange={(enabled) => updateIct({ enabled })}
        />

        <div className="grid grid-cols-2 gap-2 pt-1">
          <NumberField
            label="Swing strength"
            hint="Candles either side that must not exceed the pivot. Higher finds fewer, more significant swings."
            value={settings.swingStrength}
            min={1}
            max={20}
            disabled={!settings.enabled}
            onChange={(swingStrength) => updateIct({ swingStrength })}
          />
          <NumberField
            label="Min gap"
            hint="Ignore fair value gaps smaller than this percentage of price"
            value={settings.minGapPercent}
            min={0}
            max={5}
            step={0.01}
            suffix="%"
            disabled={!settings.enabled}
            onChange={(minGapPercent) => updateIct({ minGapPercent })}
          />
        </div>

        <div className="pt-1">
          <ToggleField
            label="Keep filled gaps"
            hint="Show gaps price has already traded fully through"
            checked={settings.includeFilledGaps}
            disabled={!settings.enabled}
            onChange={(includeFilledGaps) => updateIct({ includeFilledGaps })}
          />
          <ToggleField
            label="Keep unconfirmed SMT"
            hint="Include divergences whose anchors are neither swing points nor gap edges"
            checked={settings.includeInvalidSmt}
            disabled={!settings.enabled}
            onChange={(includeInvalidSmt) => updateIct({ includeInvalidSmt })}
          />
        </div>
      </section>

      <section className="border-t border-border pt-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="label-caps">Overlays</span>
          {query.isFetching && <Spinner className="text-muted-foreground" />}
        </div>
        <ToggleField
          label={`Swing points${analysis ? ` (${analysis.swing_points.length})` : ''}`}
          checked={settings.showSwings}
          disabled={!settings.enabled}
          onChange={(showSwings) => updateIct({ showSwings })}
        />
        <ToggleField
          label={`Fair value gaps${analysis ? ` (${analysis.fair_value_gaps.length})` : ''}`}
          checked={settings.showGaps}
          disabled={!settings.enabled}
          onChange={(showGaps) => updateIct({ showGaps })}
        />
        <ToggleField
          label={`SMT divergences${analysis ? ` (${analysis.smt_divergences.length})` : ''}`}
          checked={settings.showSmt}
          disabled={!settings.enabled}
          onChange={(showSmt) => updateIct({ showSmt })}
        />
      </section>

      {analysis?.warnings.length ? (
        <section className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2">
          <ul className="space-y-1 text-2xs leading-relaxed text-amber-300">
            {analysis.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="min-h-0 flex-1 border-t border-border pt-2">
        <div className="mb-2 flex items-center justify-between">
          <span className="label-caps">
            Divergences {references.length ? `vs ${references.join(', ')}` : ''}
          </span>
        </div>

        {!settings.enabled ? (
          <p className="text-2xs text-muted-foreground">Detectors are off.</p>
        ) : references.length === 0 ? (
          <p className="text-2xs leading-relaxed text-muted-foreground">
            SMT divergence compares two correlated markets. Add a comparison symbol in the
            toolbar to check whether {primary} took a level that the other did not.
          </p>
        ) : query.isLoading ? (
          <p className="flex items-center gap-2 text-2xs text-muted-foreground">
            <Spinner /> Scanning...
          </p>
        ) : query.isError ? (
          <p className="text-2xs text-bear">{(query.error as Error).message}</p>
        ) : analysis && analysis.smt_divergences.length > 0 ? (
          <ul className="space-y-1.5">
            {[...analysis.smt_divergences].reverse().map((item) => (
              <DivergenceRow key={`${item.end_time}-${item.kind}-${item.reference_symbol}`} item={item} />
            ))}
          </ul>
        ) : (
          <p className="text-2xs leading-relaxed text-muted-foreground">
            No divergences in this range. The markets agreed at every swing.
          </p>
        )}
      </section>

      <DrawingsSection />
    </div>
  )
}

function DivergenceRow({ item }: { item: SmtDivergence }) {
  return (
    <li className="rounded-md border border-border bg-[hsl(var(--panel-raised))] p-2">
      <div className="flex items-center gap-1.5">
        <Badge tone={item.bias === 'bullish' ? 'bull' : 'bear'}>
          {item.bias === 'bullish' ? 'Bullish' : 'Bearish'}
        </Badge>
        <span className="text-2xs text-muted-foreground">
          at a {item.kind === 'high' ? 'high' : 'low'}
        </span>
        {item.inside_fair_value_gap && (
          <Badge tone="accent" title="The pivot sits inside a fair value gap">
            in FVG
          </Badge>
        )}
        <Badge
          tone={item.validity === 'swing_pair' ? 'neutral' : 'warn'}
          title={VALIDITY_NOTES[item.validity]}
          className="ml-auto"
        >
          {VALIDITY_LABELS[item.validity]}
        </Badge>
      </div>

      <p className="mt-1.5 text-2xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">{item.leading_symbol}</span> took the{' '}
        {item.kind}; <span className="font-medium text-foreground">{item.lagging_symbol}</span>{' '}
        did not.
      </p>

      <div className="mt-1 flex items-center justify-between text-2xs text-muted-foreground">
        <span className="numeric">{formatDateTime(item.end_time)}</span>
        <span className="numeric" title="Size of the disagreement, in percentage points">
          {formatNumber(item.strength, 3)} pp
        </span>
      </div>
      <div className="numeric mt-0.5 text-2xs text-muted-foreground">
        {item.primary_symbol} {formatPrice(item.primary_start_price)} &rarr;{' '}
        {formatPrice(item.primary_end_price)}
      </div>
    </li>
  )
}

function DrawingsSection() {
  const drawings = useWorkspace((state) => state.drawings)
  const primary = useWorkspace((state) => state.primarySymbol)
  const selectedId = useWorkspace((state) => state.selectedDrawingId)
  const selectDrawing = useWorkspace((state) => state.selectDrawing)
  const removeDrawing = useWorkspace((state) => state.removeDrawing)

  const visible = drawings.filter((drawing) => drawing.symbol === primary)

  return (
    <section className="border-t border-border pt-2">
      <span className="label-caps">Drawings on {primary}</span>
      {visible.length === 0 ? (
        <EmptyState
          className="py-4"
          title="Nothing drawn yet"
          description="Pick a tool in the toolbar, then drag on the chart. Drawings snap to swing points and survive an interval change."
        />
      ) : (
        <ul className="mt-1.5 space-y-1">
          {visible.map((drawing) => (
            <li key={drawing.id}>
              <div
                className={cn(
                  'flex items-center gap-2 rounded-md border px-2 py-1.5 text-2xs transition-colors',
                  drawing.id === selectedId
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-border bg-[hsl(var(--panel-raised))] hover:border-border/80',
                )}
              >
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={() =>
                    selectDrawing(drawing.id === selectedId ? null : drawing.id)
                  }
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: drawing.color }}
                  />
                  <span className="truncate">{TOOL_LABELS[drawing.kind]}</span>
                  <span className="numeric ml-auto shrink-0 text-muted-foreground">
                    {drawing.kind === 'horizontal'
                      ? formatPrice(drawing.price)
                      : formatDateTime(drawing.from.time)}
                  </span>
                </button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-5 w-5 shrink-0"
                  onClick={() => removeDrawing(drawing.id)}
                  title="Delete this drawing"
                  aria-label="Delete drawing"
                >
                  <Trash2 size={12} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
