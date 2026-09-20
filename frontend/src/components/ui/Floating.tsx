/**
 * A small panel that opens over everything, at a point on the window.
 *
 * Portalled to the body rather than positioned inside whatever opened it,
 * because the places this is used sit inside an ancestor that clips. The
 * chart panel hides its overflow so candles cannot escape the pane; the tool
 * rail is forty pixels wide and scrolls, and a box that scrolls on one axis
 * clips on the other. A menu absolutely positioned inside either one is cut
 * off at the edge -- which is how the chart-link switches came to be
 * unreachable from *both* of the two doors that are meant to reach them, the
 * rail popover clipped sideways by a 40px column and the right-click menu
 * cut off 75px above its own last section.
 *
 * Staying on screen is three separate jobs, and doing only the first is what
 * the constant this replaced was doing:
 *
 * - **Place it where it fits.** Clamped after measuring, never against a
 *   written-down size. The old constant claimed 168px while the menu had
 *   grown to 251, and nothing about adding a switch to a menu suggests going
 *   to look for the number that says how tall it is.
 * - **Keep it there.** A placement computed once goes stale the moment the
 *   window is resized or the anchor scrolls, and a `fixed` panel that has
 *   gone stale cannot be scrolled back to -- shrinking the window from 900px
 *   to 420px left the whole 283px panel below the fold and unreachable.
 * - **Let it be smaller than its contents.** Clamping only moves a panel; it
 *   cannot help one that is taller than the window, so the panel scrolls
 *   rather than spilling off the bottom.
 */

import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react'
import { createPortal } from 'react-dom'

import { cn } from '@/utils/cn'

/** Kept off the window edges, so a clamped panel still reads as floating. */
const EDGE_PX = 8

interface Props {
  /** Where to put the top-left corner, in window coordinates, before clamping. */
  at: { x: number; y: number }
  /** Asked to close by Escape, or by a press outside the panel. */
  onClose: () => void
  /**
   * The control this belongs to, when it has one. Two jobs: a press in here
   * does not count as outside -- without that the press closes the panel and
   * the click that follows re-opens it, so a toggle button only ever opens --
   * and the panel follows this element when it moves, which is how it stays
   * beside a button in a rail that scrolls.
   */
  anchorRef?: RefObject<HTMLElement | null>
  label: string
  className?: string
  children: ReactNode
}

export function Floating({ at, onClose, anchorRef, label, className, children }: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const anchorBox = () => anchorRef?.current?.getBoundingClientRect() ?? null

    // How far the caller put the panel from its anchor, measured once so the
    // panel can follow the anchor later without the caller having to hand
    // over its own placement rule.
    const start = anchorBox()
    const offset = start ? { dx: at.x - start.left, dy: at.y - start.top } : null

    const place = () => {
      const anchor = offset ? anchorBox() : null
      const want =
        anchor && offset
          ? { x: anchor.left + offset.dx, y: anchor.top + offset.dy }
          : at

      const box = panel.getBoundingClientRect()
      const fit = (edge: number, size: number, limit: number) =>
        Math.max(EDGE_PX, Math.min(edge, limit - size - EDGE_PX))

      // Written only when it changes. `place` is also the resize observer's
      // callback, and a write that dirties layout on every delivery is how a
      // panel whose width depends on its position oscillates.
      const left = `${fit(want.x, box.width, window.innerWidth)}px`
      const top = `${fit(want.y, box.height, window.innerHeight)}px`
      if (panel.style.left !== left) panel.style.left = left
      if (panel.style.top !== top) panel.style.top = top
    }

    place()

    // Three things move a panel out from under itself: its own contents
    // changing height, the window changing size, and the anchor scrolling.
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    window.addEventListener('resize', place)
    // Capture, because a scroll in a container between the anchor and the
    // window does not bubble -- and the rail the settings button sits in is
    // exactly such a container.
    window.addEventListener('scroll', place, { capture: true })

    return () => {
      observer.disconnect()
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, { capture: true })
    }
  }, [at, anchorRef])

  useEffect(() => {
    // Read from the DOM rather than through React's tree: the panel is
    // portalled out of the component that owns it, so asking anything up
    // there whether it contains the press would say it happened outside.
    const away = (event: MouseEvent) => {
      const target = event.target as Node
      if (panelRef.current?.contains(target)) return
      if (anchorRef?.current?.contains(target)) return
      onClose()
    }

    /*
     * Taken in the capture phase and stopped, so dismissing a panel is only
     * that.
     *
     * The drawing shortcuts and the focus-mode toggle both listen for Escape
     * on the window, neither knows a panel is open, and both ran on the same
     * keystroke: pressing Escape to close this menu while holding the trend
     * line tool closed the menu *and* dropped the tool back to the cursor.
     * `ChartOverlay` solves the same collision the same way.
     */
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }

    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape, { capture: true })
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape, { capture: true })
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={panelRef}
      // `group`, not `menu`: these panels hold checkboxes and colour buttons,
      // and an ARIA menu promises `menuitem` children that a screen reader
      // then goes looking for and does not find.
      role="group"
      aria-label={label}
      // The pane's own right-click handler used to catch presses on the menu
      // because the menu was inside it. Portalled out, nothing suppresses the
      // browser's native menu, which would otherwise open on top of this one.
      onContextMenu={(event) => event.preventDefault()}
      className={cn(
        'fixed z-50 max-h-[calc(100vh-16px)] overflow-y-auto overscroll-contain',
        'rounded-md border border-border bg-[hsl(var(--popover))] p-2 shadow-lg',
        className,
      )}
      // Set here so the first paint lands near the pointer rather than in the
      // corner; the measure above corrects it before the frame is shown.
      style={{ left: at.x, top: at.y }}
    >
      {children}
    </div>,
    document.body,
  )
}
