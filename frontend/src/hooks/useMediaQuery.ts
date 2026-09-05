/**
 * A CSS media query, as a boolean the layout can branch on.
 *
 * Used where a breakpoint changes *structure* rather than style -- a side
 * panel that sits beside the chart on a laptop and over it on a tablet -- and
 * so cannot be expressed in a class name.
 */

import { useEffect, useState } from 'react'

function match(query: string): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }
  return window.matchMedia(query).matches
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => match(query))

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const list = window.matchMedia(query)
    const update = () => setMatches(list.matches)
    // Read once on mount as well: the window may have been resized between
    // the first render and this effect running.
    update()
    list.addEventListener('change', update)
    // Belt and braces, because the change event is not always dispatched.
    // A viewport that is *emulated* -- a device preview, a headless run --
    // re-evaluates the query silently: `matches` goes true while nothing
    // fires, and the layout is left a breakpoint behind. Watching the root
    // element covers that, since a viewport change always relays it out.
    // Every path calls the same setter, and setting the value it already
    // holds is a no-op, so the duplicates cost nothing.
    window.addEventListener('resize', update)
    const observer =
      typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    observer?.observe(document.documentElement)

    return () => {
      list.removeEventListener('change', update)
      window.removeEventListener('resize', update)
      observer?.disconnect()
    }
  }, [query])

  return matches
}

/**
 * Too narrow to put a settings panel beside a chart.
 *
 * Below this the two together leave the candles a sliver, so the panel opens
 * over the chart instead of next to it.
 */
export const NARROW_QUERY = '(max-width: 899px)'

/**
 * Too narrow to put two charts side by side.
 *
 * A chart needs width the way a paragraph needs it: below roughly 300px a pane
 * is a legend, a price axis and about eight candles, which answers no question
 * worth asking. Two of those across a phone is worse than one of them, so
 * below this the arrangement stops being a choice and everything stacks.
 */
export const CRAMPED_QUERY = '(max-width: 599px)'
