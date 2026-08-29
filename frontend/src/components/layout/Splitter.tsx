/**
 * A draggable divider between two flex children.
 *
 * Panes in this workspace are sized by ratio rather than by pixels, so that a
 * split set on a laptop still means the same thing on an external monitor.
 * The splitter measures its own parent -- it is always a direct child of the
 * flex container it divides -- and reports where along that box the pointer
 * landed, as a fraction.
 *
 * It is a real `separator` with arrow-key support, because a divider that can
 * only be dragged is a divider that cannot be moved without a mouse.
 */

import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react'

import { cn } from '@/utils/cn'

const KEY_STEP = 0.02

interface Props {
  /** `row` splits left from right; `column` splits top from bottom. */
  direction: 'row' | 'column'
  /** Share of the container given to the pane before the divider, 0..1. */
  ratio: number
  onRatioChange: (ratio: number) => void
  min?: number
  max?: number
  label: string
  className?: string
}

export function Splitter({
  direction,
  ratio,
  onRatioChange,
  min = 0.2,
  max = 0.85,
  label,
  className,
}: Props) {
  const boxRef = useRef<DOMRect | null>(null)
  const clamp = useCallback(
    (value: number) => Math.min(max, Math.max(min, value)),
    [min, max],
  )

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const parent = event.currentTarget.parentElement
    if (!parent) return
    boxRef.current = parent.getBoundingClientRect()
    event.currentTarget.setPointerCapture(event.pointerId)
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = boxRef.current
    if (!box) return
    const next =
      direction === 'row'
        ? (event.clientX - box.left) / box.width
        : (event.clientY - box.top) / box.height
    if (Number.isFinite(next)) onRatioChange(clamp(next))
  }

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    boxRef.current = null
    event.currentTarget.releasePointerCapture(event.pointerId)
  }

  return (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={direction === 'row' ? 'vertical' : 'horizontal'}
      aria-valuenow={Math.round(ratio * 100)}
      aria-valuemin={Math.round(min * 100)}
      aria-valuemax={Math.round(max * 100)}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onKeyDown={(event) => {
        const back = direction === 'row' ? 'ArrowLeft' : 'ArrowUp'
        const forward = direction === 'row' ? 'ArrowRight' : 'ArrowDown'
        if (event.key !== back && event.key !== forward) return
        event.preventDefault()
        onRatioChange(clamp(ratio + (event.key === forward ? KEY_STEP : -KEY_STEP)))
      }}
      className={cn(
        'group relative z-10 shrink-0 bg-border transition-colors',
        'hover:bg-primary/70 focus-visible:bg-primary focus-visible:outline-none',
        // The hit area is padded out past the hairline: a 1px target is
        // technically draggable and practically not.
        direction === 'row'
          ? 'w-px cursor-col-resize after:absolute after:inset-y-0 after:-left-1 after:-right-1 after:content-[""]'
          : 'h-px cursor-row-resize after:absolute after:inset-x-0 after:-top-1 after:-bottom-1 after:content-[""]',
        className,
      )}
    />
  )
}
