import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

import { NumberField } from '@/components/ui/fields'

function setup(value: number, props: Partial<Parameters<typeof NumberField>[0]> = {}) {
  const onChange = vi.fn()
  render(<NumberField label="Fees" value={value} onChange={onChange} step={0.01} {...props} />)
  return { onChange, input: screen.getByLabelText('Fees') as HTMLInputElement }
}

describe('NumberField', () => {
  it('renders a decimal point regardless of browser locale', () => {
    // The chart price axis uses toFixed and every readout uses en-US, so the
    // input must not be the one control showing "0,02".
    const { input } = setup(0.02)
    expect(input.value).toBe('0.02')
  })

  it('accepts a comma as a decimal separator', async () => {
    const { onChange, input } = setup(0)
    await userEvent.clear(input)
    await userEvent.type(input, '1,5')
    expect(onChange).toHaveBeenLastCalledWith(1.5)
  })

  it('keeps a half-typed value out of the callback', async () => {
    const { onChange, input } = setup(1)
    await userEvent.clear(input)
    await userEvent.type(input, '-')
    // "-" is not a number yet; publishing it would put NaN in a request body.
    expect(onChange).not.toHaveBeenCalledWith(NaN)
  })

  it('lets a trailing decimal point survive a keystroke', async () => {
    const { input } = setup(0)
    await userEvent.clear(input)
    await userEvent.type(input, '2.')
    expect(input.value).toBe('2.')
  })

  it('steps with the arrow keys without float drift', async () => {
    const { onChange, input } = setup(0.02, { step: 0.01 })
    await userEvent.click(input)
    await userEvent.keyboard('{ArrowUp}')
    // Naive addition gives 0.030000000000000002.
    expect(onChange).toHaveBeenLastCalledWith(0.03)
  })

  it('clamps arrow stepping to the allowed range', async () => {
    const { onChange, input } = setup(0, { step: 0.01, min: 0 })
    await userEvent.click(input)
    await userEvent.keyboard('{ArrowDown}')
    expect(onChange).toHaveBeenLastCalledWith(0)
  })

  it('flags a value outside the range', async () => {
    const { input } = setup(1, { min: 0, max: 5 })
    await userEvent.clear(input)
    await userEvent.type(input, '9')
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })
})
