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

/*
 * What a field may hand to the store, as against what it may show.
 *
 * Every one of these values used to be published while the field went red:
 * the backend then refused the run with "The configuration could not be used
 * as entered", naming no field, and a fractional swing strength failed the
 * analysis request outright -- every detection left the chart with no message
 * at all. The text the user typed stays on screen, marked; the setting keeps
 * the last value it can actually hold.
 */
describe('NumberField publishes only values the setting can hold', () => {
  it('keeps an out-of-range entry off the store', async () => {
    const { onChange, input } = setup(1, { min: 0, max: 5 })
    await userEvent.clear(input)
    await userEvent.type(input, '9')

    expect(onChange).not.toHaveBeenCalledWith(9)
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('refuses a fraction in a whole-number field, and says so', async () => {
    const { onChange, input } = setup(2, { min: 1, max: 20, integer: true, step: 1 })
    await userEvent.clear(input)
    await userEvent.type(input, '2.5')

    expect(onChange).not.toHaveBeenCalledWith(2.5)
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input.title).toMatch(/whole number from 1 to 20/i)
  })

  it('goes back to the value in force once the field is left', async () => {
    const { input } = setup(2, { min: 1, max: 20, integer: true, step: 1 })
    await userEvent.clear(input)
    await userEvent.type(input, '2.5')
    await userEvent.tab()

    expect(input.value).toBe('2')
    expect(input).not.toHaveAttribute('aria-invalid')
  })

  it('treats an exclusive minimum as exclusive', async () => {
    // A stop or a target of zero is refused by the backend outright.
    const { onChange, input } = setup(1, { min: 0, minExclusive: true, step: 0.1 })
    await userEvent.clear(input)
    await userEvent.type(input, '0')

    expect(onChange).not.toHaveBeenCalledWith(0)
    expect(input).toHaveAttribute('aria-invalid', 'true')
  })

  it('never steps onto an exclusive minimum', async () => {
    const { onChange, input } = setup(0.1, { min: 0, minExclusive: true, step: 0.1 })
    await userEvent.click(input)
    await userEvent.keyboard('{ArrowDown}')

    expect(onChange).not.toHaveBeenCalledWith(0)
  })

  it('steps a whole-number field in whole numbers from a fractional entry', async () => {
    const { onChange, input } = setup(2, { min: 1, max: 20, integer: true, step: 1 })
    await userEvent.clear(input)
    await userEvent.type(input, '2.5')
    await userEvent.keyboard('{ArrowUp}')

    expect(onChange).toHaveBeenLastCalledWith(3)
  })

  it('still publishes an ordinary entry as it is typed', async () => {
    const { onChange, input } = setup(2, { min: 1, max: 20, integer: true, step: 1 })
    await userEvent.clear(input)
    await userEvent.type(input, '12')

    expect(onChange).toHaveBeenLastCalledWith(12)
  })
})
