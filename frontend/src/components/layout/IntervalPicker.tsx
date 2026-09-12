/**
 * Choosing a timeframe, once there are thirteen of them.
 *
 * The workspace shipped with six intervals in a strip across the top bar,
 * which fits. Miles asked for 1m, 2m, 3m, 30m, 90m, weekly and monthly on top
 * of that -- "a really big thing", because a trader reads structure on the
 * weekly and takes entries on the 3-minute -- and thirteen buttons is no
 * longer a strip, it is a wall of text that overflows a laptop bar and is
 * slower to read than a menu.
 *
 * So: the ones you use stay one click away, and the rest are one click
 * further. Which is which is the trader's choice, not ours, and it persists.
 */

import { useEffect, useRef, useState } from 'react'
import { ChevronDown, Pin, PinOff } from 'lucide-react'

import { Button } from '@/components/ui/primitives'
import { SegmentedControl } from '@/components/ui/fields'
import { useWorkspace } from '@/store/workspace'
import {
  INTERVAL_GROUPS,
  INTERVAL_LABELS,
  MAX_RANGE_DAYS,
  type Interval,
} from '@/types/market'
import { cn } from '@/utils/cn'

/** How far back an interval reaches, said in the units a trader thinks in. */
function reachOf(interval: Interval): string {
  const days = MAX_RANGE_DAYS[interval]
  if (days >= 365) return `${Math.round(days / 365)}y history`
  if (days >= 30) return `${Math.round(days / 30)}mo history`
  return `${days}d history`
}

export function IntervalPicker() {
  const interval = useWorkspace((state) => state.interval)
  const setInterval = useWorkspace((state) => state.setInterval)
  const favourites = useWorkspace((state) => state.favouriteIntervals)
  const toggleFavourite = useWorkspace((state) => state.toggleFavouriteInterval)

  const [open, setOpen] = useState(false)
  const boxRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape)
    }
  }, [open])

  /*
   * An interval chosen from the menu but not pinned still has to show as
   * selected somewhere, or the bar reads as though nothing is active. It
   * takes a place at the end of the row for as long as it is the current one
   * -- without being pinned, so it leaves again when you move off it.
   */
  const pinned = favourites.includes(interval)
  const row: Interval[] = pinned ? favourites : [...favourites, interval]

  return (
    <div ref={boxRef} className="relative flex shrink-0 items-center">
      <SegmentedControl<Interval>
        variant="plain"
        value={interval}
        options={row.map((item) => ({
          value: item,
          label: INTERVAL_LABELS[item],
          title: `${INTERVAL_LABELS[item]} bars — ${reachOf(item)}`,
        }))}
        onChange={setInterval}
      />

      <Button
        size="icon"
        variant="toolbar"
        data-active={open}
        onClick={() => setOpen((was) => !was)}
        title="All timeframes"
        aria-label="All timeframes"
        aria-expanded={open}
      >
        <ChevronDown size={14} />
      </Button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1 w-60 rounded-md border border-border bg-[hsl(var(--popover))] p-2 shadow-lg">
          {INTERVAL_GROUPS.map((group) => (
            <div key={group.label} className="mb-2 last:mb-0">
              <div className="label-caps px-1 pb-1">{group.label}</div>
              <div className="space-y-px">
                {group.intervals.map((item) => (
                  <IntervalRow
                    key={item}
                    interval={item}
                    active={item === interval}
                    pinned={favourites.includes(item)}
                    onPick={() => {
                      setInterval(item)
                      setOpen(false)
                    }}
                    onPin={() => toggleFavourite(item)}
                  />
                ))}
              </div>
            </div>
          ))}
          <p className="border-t border-border px-1 pt-2 text-2xs text-muted">
            Pin the ones you use to keep them in the bar.
          </p>
        </div>
      )}
    </div>
  )
}

function IntervalRow({
  interval,
  active,
  pinned,
  onPick,
  onPin,
}: {
  interval: Interval
  active: boolean
  pinned: boolean
  onPick: () => void
  onPin: () => void
}) {
  return (
    <div
      className={cn(
        'flex items-center gap-1 rounded pr-1',
        active && 'bg-[hsl(var(--accent))]',
      )}
    >
      <button
        type="button"
        onClick={onPick}
        aria-pressed={active}
        className={cn(
          'flex flex-1 items-center justify-between gap-2 rounded px-2 py-1 text-left text-xs transition-colors',
          active ? 'font-semibold' : 'hover:bg-[hsl(var(--accent))]',
        )}
      >
        <span>{INTERVAL_LABELS[interval]}</span>
        {/*
          How far back the interval reaches, stated up front. Every one of
          these is bounded by how much the backend can store, and finding that
          out by choosing a timeframe and watching the range collapse is the
          kind of surprise that reads as a bug.
        */}
        <span className="text-2xs text-muted">{reachOf(interval)}</span>
      </button>
      <button
        type="button"
        onClick={onPin}
        aria-pressed={pinned}
        title={pinned ? `Unpin ${INTERVAL_LABELS[interval]}` : `Pin ${INTERVAL_LABELS[interval]} to the bar`}
        aria-label={pinned ? `Unpin ${INTERVAL_LABELS[interval]}` : `Pin ${INTERVAL_LABELS[interval]}`}
        className={cn(
          'rounded p-1 transition-colors',
          pinned ? 'text-foreground' : 'text-muted opacity-40 hover:opacity-100',
        )}
      >
        {pinned ? <Pin size={12} /> : <PinOff size={12} />}
      </button>
    </div>
  )
}
