/**
 * Two ways in to a strategy that are not a blank form.
 *
 * A dozen fields with nothing in them asks you to have already decided
 * everything, and the fastest way to find out what a field does is to load an
 * arrangement that hangs together and change one thing. Miles and Herdy
 * settled on presets first and interpretation of a written description after,
 * which is the order they appear in here.
 *
 * Both are **starting points**. Neither is claimed to work, and nothing here
 * runs anything: the strategy lands on the form, where the same interval,
 * baseline and configuration count apply to it as to a strategy typed in by
 * hand. A preset that arrived with a win rate attached would be the exact
 * thing this tool exists to argue against.
 */

import { useState } from 'react'
import { Sparkles, Wand2 } from 'lucide-react'

import { Button, Disclosure } from '@/components/ui/primitives'
import { applyPreset, STRATEGY_PRESETS, type StrategyPreset } from '@/lib/presets'
import { interpret, type Interpretation } from '@/lib/strategyLanguage'
import { useWorkspace } from '@/store/workspace'
import { cn } from '@/utils/cn'

const EXAMPLE =
  'Long NQ inside a fair value gap within 5 bars, 1% stop, 2R target, ' +
  'hold at most 24 bars, top 30 matches over the last 180 days.'

export function StrategyStart() {
  const updateRules = useWorkspace((state) => state.updateRules)
  const updateSearch = useWorkspace((state) => state.updateSearch)
  const updateDetectors = useWorkspace((state) => state.updateDetectors)

  const [chosen, setChosen] = useState<StrategyPreset | null>(null)
  const [text, setText] = useState('')
  const [read, setRead] = useState<Interpretation | null>(null)

  const loadPreset = (preset: StrategyPreset) => {
    const next = applyPreset(preset)
    updateRules(next.rules)
    updateSearch(next.search)
    updateDetectors(next.detectors)
    setChosen(preset)
    // The two routes set the same fields, so leaving the other one's account
    // on screen would describe a form that no longer matches it.
    setRead(null)
  }

  const readDescription = () => {
    const interpretation = interpret(text)
    updateRules(interpretation.rules)
    updateSearch(interpretation.search)
    updateDetectors(interpretation.detectors)
    setRead(interpretation)
    setChosen(null)
  }

  return (
    <Disclosure
      label="Start from"
      summary="A preset, or a description in words"
      divided={false}
    >
      <div className="space-y-3 pt-1">
        <div className="space-y-1">
          {STRATEGY_PRESETS.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => loadPreset(preset)}
              aria-pressed={chosen?.id === preset.id}
              className={cn(
                'w-full rounded border border-border px-2 py-1.5 text-left transition-colors hover:bg-[hsl(var(--accent))]',
                chosen?.id === preset.id && 'bg-[hsl(var(--accent))]',
              )}
            >
              <div className="flex items-center gap-1.5">
                <Sparkles size={11} className="shrink-0 text-muted-foreground" />
                <span className="text-xs font-semibold">{preset.name}</span>
              </div>
              <p className="pt-0.5 text-2xs leading-snug text-muted-foreground">
                {preset.summary}
              </p>
            </button>
          ))}
        </div>

        {chosen && (
          <p className="rounded border-l-2 border-primary/50 bg-[hsl(var(--panel-raised))] px-2 py-1.5 text-2xs leading-relaxed text-muted-foreground">
            {chosen.rationale}
          </p>
        )}

        <div className="space-y-1.5 border-t border-border pt-3">
          <div className="label-caps">Describe it instead</div>
          <textarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={3}
            placeholder={EXAMPLE}
            aria-label="Strategy description"
            className="w-full resize-y rounded border border-border bg-[hsl(var(--panel-raised))] px-2 py-1.5 text-2xs leading-relaxed outline-none focus:border-primary/60"
          />
          <div className="flex items-center gap-1.5">
            <Button size="sm" variant="secondary" onClick={readDescription} disabled={!text.trim()}>
              <Wand2 size={12} className="mr-1" />
              Read it
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setText(EXAMPLE)}>
              Use the example
            </Button>
          </div>

          {/*
            This is a grammar, not a model, and saying so is the point rather
            than a disclaimer: a form filled in by something that cannot say
            why would be the same defect as a win rate quoted without its
            interval, one step earlier in the process.
          */}
          <p className="text-[10px] leading-snug text-muted">
            Phrase matching, not a language model. Everything it sets is listed
            below, and so is anything it could not read.
          </p>
        </div>

        {read && <Account read={read} />}
      </div>
    </Disclosure>
  )
}

function Account({ read }: { read: Interpretation }) {
  return (
    <div className="space-y-2 border-t border-border pt-2">
      {read.understood.length > 0 ? (
        <div className="space-y-0.5">
          <div className="label-caps">Set from your description</div>
          {read.understood.map((item, index) => (
            <div
              key={`${item.setting}-${index}`}
              className="flex items-baseline justify-between gap-2 text-2xs"
            >
              <span className="text-muted-foreground">
                {item.setting}
                {/* The words responsible, quoted back, so the mapping is
                    checkable rather than taken on trust. */}
                <span className="pl-1 italic opacity-70">“{item.phrase}”</span>
              </span>
              <span className="numeric shrink-0">{item.value}</span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-2xs text-muted-foreground">
          Nothing in that described a setting. Everything is still at its default.
        </p>
      )}

      {read.unread.length > 0 && (
        <div className="rounded border-l-2 border-[hsl(var(--warning,38_92%_50%))] bg-[hsl(var(--panel-raised))] px-2 py-1.5">
          <div className="label-caps pb-0.5">Not understood</div>
          {read.unread.map((clause, index) => (
            <p key={index} className="text-2xs leading-snug text-muted-foreground">
              “{clause}”
            </p>
          ))}
          <p className="pt-1 text-[10px] leading-snug text-muted">
            These set nothing. If they matter, set them on the form below.
          </p>
        </div>
      )}
    </div>
  )
}
