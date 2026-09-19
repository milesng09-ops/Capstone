/**
 * A small panel that opens over everything, at a point on the window.
 *
 * Portalled to the body rather than positioned inside whatever opened it,
 * because both of the places this is used sit inside an ancestor that clips.
 * The chart panel hides its overflow so candles cannot escape the pane; the
 * tool rail is forty pixels wide and scrolls. A menu absolutely positioned
 * inside either one is cut off at the edge -- which is how the chart-link
 * switches came to be unreachable from *both* of the two doors that are
 * meant to reach them: the rail popover clipped sideways by a 40px column,
 * and the right-click menu cut off 75px above its own last section.
 *
 * The position is clamped after measuring, not against a written-down size.
 * The constant that used to do that job claimed 168px while the menu had
 * grown to 251, and nothing about adding a switch to a menu suggests going
 * to look for the number that says how tall it is.
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
   * A press in here does not count as outside. For a panel opened by a
   * toggle: without it the press closes the panel and the click that follows
   * re-opens it, so the button only ever opens.
   */
  anchorRef?: RefObject<HTMLElement | null>
  label: string
  role?: 'menu' | 'dialog'
  className?: string
  children: ReactNode
}

export function Floating({
  at,
  onClose,
  anchorRef,
  label,
  role = 'menu',
  className,
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!panel) return

    const place = () => {
      const box = panel.getBoundingClientRect()
      const fit = (want: number, size: number, limit: number) =>
        Math.max(EDGE_PX, Math.min(want, limit - size - EDGE_PX))

      panel.style.left = `${fit(at.x, box.width, window.innerWidth)}px`
      panel.style.top = `${fit(at.y, box.height, window.innerHeight)}px`
    }

    place()
    // Placed again whenever the panel's own content changes size: opening the
    // colour row inside it is enough to push the bottom off the window.
    const observer = new ResizeObserver(place)
    observer.observe(panel)
    return () => observer.disconnect()
  }, [at])

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
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }

    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', escape)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', escape)
    }
  }, [anchorRef, onClose])

  return createPortal(
    <div
      ref={panelRef}
      role={role}
      aria-label={label}
      className={cn(
        'fixed z-50 rounded-md border border-border bg-[hsl(var(--popover))] p-2 shadow-lg',
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
