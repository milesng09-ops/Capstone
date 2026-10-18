import { fireEvent, render } from '@testing-library/react'
import { beforeAll, expect, it, vi } from 'vitest'

import { Splitter } from '@/components/layout/Splitter'

beforeAll(() => {
  // jsdom has no pointer capture; the splitter only needs it not to throw.
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

function setup() {
  const onRatioChange = vi.fn()
  const { getByRole, container } = render(
    <div>
      <Splitter direction="row" ratio={0.5} onRatioChange={onRatioChange} label="Resize" />
    </div>,
  )
  const parent = container.firstElementChild as HTMLElement
  parent.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500 }) as DOMRect
  return { separator: getByRole('separator'), onRatioChange }
}

function pointer(type: string, clientX: number) {
  return new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY: 10 })
}

it('follows the pointer while the button is down', () => {
  const { separator, onRatioChange } = setup()
  fireEvent(separator, pointer('pointerdown', 500))
  fireEvent(separator, pointer('pointermove', 600))
  expect(onRatioChange).toHaveBeenLastCalledWith(0.6)
})

it.each(['pointercancel', 'lostpointercapture'])(
  'stops resizing once the pointer is taken away (%s)',
  (ending) => {
    // Alt+Tab with the button down, or a touch the browser took for a scroll:
    // no pointerup ever arrives, and the next hover kept dragging the divider.
    const { separator, onRatioChange } = setup()
    fireEvent(separator, pointer('pointerdown', 500))
    fireEvent(separator, pointer(ending, 500))
    fireEvent(separator, pointer('pointermove', 700))
    expect(onRatioChange).not.toHaveBeenCalled()
  },
)

it('starts a drag rather than a text selection', () => {
  const { separator } = setup()
  const down = pointer('pointerdown', 500)
  fireEvent(separator, down)
  expect(down.defaultPrevented).toBe(true)
})
