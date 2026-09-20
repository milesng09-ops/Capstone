/**
 * The panel three popovers now hang off.
 *
 * Two of these are regressions with a cost that was measured in the browser
 * rather than guessed at: a panel placed once and never placed again sat
 * 353px below the fold after the window was shrunk, and Escape closing the
 * panel *also* dropped the drawing tool the user was holding. Both are
 * invisible to a test that only asks whether the panel renders.
 */

import { useRef } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { Floating } from '@/components/ui/Floating'

/**
 * jsdom gives every element a zero-sized rect, which makes every clamp a
 * no-op and every placement assertion pass. The panel is given a real size so
 * the arithmetic has something to be wrong about.
 */
function sizePanel(width: number, height: number) {
  const original = HTMLElement.prototype.getBoundingClientRect
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.getAttribute('role') === 'group'
      ? ({ width, height, left: 0, top: 0, right: width, bottom: height } as DOMRect)
      : original.call(this)
  }
  return () => {
    HTMLElement.prototype.getBoundingClientRect = original
  }
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true })
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true })
}

let restoreRect: (() => void) | null = null

afterEach(() => {
  restoreRect?.()
  restoreRect = null
})

function Harness({
  at = { x: 10, y: 10 },
  onClose = () => {},
  withAnchor = false,
}: {
  at?: { x: number; y: number }
  onClose?: () => void
  withAnchor?: boolean
}) {
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  return (
    <div>
      <button ref={anchorRef} type="button">
        anchor
      </button>
      <button type="button">elsewhere</button>
      <Floating
        at={at}
        onClose={onClose}
        anchorRef={withAnchor ? anchorRef : undefined}
        label="Test panel"
      >
        <button type="button">inside</button>
      </Floating>
    </div>
  )
}

const panel = () => screen.getByRole('group', { name: 'Test panel' })

describe('Floating', () => {
  it('renders outside the tree that opened it', () => {
    // The whole point: the callers sit inside ancestors that clip.
    const { container } = render(<Harness />)

    expect(container.querySelector('[role="group"]')).toBeNull()
    expect(panel().parentElement).toBe(document.body)
  })

  it('keeps the panel inside the window when it would overflow', () => {
    restoreRect = sizePanel(200, 300)
    setViewport(1024, 400)

    render(<Harness at={{ x: 1000, y: 380 }} />)

    // 1024 - 200 - 8, and 400 - 300 - 8.
    expect(panel().style.left).toBe('816px')
    expect(panel().style.top).toBe('92px')
  })

  it('places it again when the window is resized under it', () => {
    /*
     * Measured in the browser before this was fixed: with the panel open,
     * shrinking the viewport from 900 to 420 left it pinned at top 490 with
     * all 283px of it below the fold -- and `position: fixed` means there is
     * nothing to scroll to get it back.
     */
    restoreRect = sizePanel(200, 300)
    setViewport(1024, 900)

    render(<Harness at={{ x: 10, y: 500 }} />)
    expect(panel().style.top).toBe('500px')

    setViewport(1024, 420)
    fireEvent(window, new Event('resize'))

    expect(panel().style.top).toBe('112px')
  })

  it('scrolls its own contents rather than spilling off a short window', () => {
    // Clamping can only move a panel. One taller than the window has to be
    // allowed to be smaller than its contents.
    render(<Harness />)

    expect(panel().className).toContain('overflow-y-auto')
    expect(panel().className).toContain('max-h-[calc(100vh-16px)]')
  })

  it('closes on a press outside', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    fireEvent.mouseDown(screen.getByRole('button', { name: 'elsewhere' }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('stays open for a press on its own contents', () => {
    const onClose = vi.fn()
    render(<Harness onClose={onClose} />)

    fireEvent.mouseDown(screen.getByRole('button', { name: 'inside' }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('stays open for a press on the control that opened it', () => {
    // Without this the press closes the panel and the click that follows
    // re-opens it, so a toggle button only ever opens.
    const onClose = vi.fn()
    render(<Harness onClose={onClose} withAnchor />)

    fireEvent.mouseDown(screen.getByRole('button', { name: 'anchor' }))

    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes on Escape without letting the keystroke reach the app', () => {
    /*
     * The drawing shortcuts and the focus-mode toggle both listen for Escape
     * on the window and neither knows a panel is open. Before this was taken
     * in the capture phase and stopped, dismissing the menu while holding
     * the trend line tool also dropped the tool back to the cursor.
     */
    const onClose = vi.fn()
    const appShortcut = vi.fn()
    window.addEventListener('keydown', appShortcut)

    render(<Harness onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'Escape' })

    window.removeEventListener('keydown', appShortcut)
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(appShortcut).not.toHaveBeenCalled()
  })

  it('leaves other keys alone', () => {
    const onClose = vi.fn()
    const appShortcut = vi.fn()
    window.addEventListener('keydown', appShortcut)

    render(<Harness onClose={onClose} />)
    fireEvent.keyDown(window, { key: 'r' })

    window.removeEventListener('keydown', appShortcut)
    expect(onClose).not.toHaveBeenCalled()
    expect(appShortcut).toHaveBeenCalledTimes(1)
  })

  it('is a group rather than a menu', () => {
    // These panels hold checkboxes and colour buttons. An ARIA menu promises
    // `menuitem` children that a screen reader then goes looking for.
    render(<Harness />)

    expect(screen.queryByRole('menu')).toBeNull()
    expect(panel()).toBeInTheDocument()
  })

  it('stops the browser menu opening on top of it', () => {
    // The pane's own right-click handler used to catch this, because the
    // menu was a child of the pane. Portalled out, nothing else will.
    render(<Harness />)

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true })
    panel().dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
  })

  it('takes its listeners with it when it goes', () => {
    const onClose = vi.fn()
    const { unmount } = render(<Harness onClose={onClose} />)

    unmount()
    fireEvent.mouseDown(document.body)
    fireEvent.keyDown(window, { key: 'Escape' })

    expect(onClose).not.toHaveBeenCalled()
  })
})
