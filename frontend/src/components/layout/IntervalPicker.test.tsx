/**
 * The timeframe picker, once the list outgrew the toolbar.
 *
 * The cases here are the ones that decide whether thirteen intervals are
 * usable or merely present: that an interval chosen from the menu still shows
 * as selected in the bar, and that pinning cannot leave the bar empty.
 */

import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { IntervalPicker } from '@/components/layout/IntervalPicker'
import { useWorkspace } from '@/store/workspace'
import { DEFAULT_FAVOURITE_INTERVALS } from '@/types/market'

function openMenu() {
  fireEvent.click(screen.getByRole('button', { name: 'All timeframes' }))
}

/** The inline strip, which is the only `group` the picker renders. */
function bar() {
  return screen.getByRole('group')
}

describe('IntervalPicker', () => {
  beforeEach(() => {
    useWorkspace.setState({
      interval: '1h',
      rangeDays: 180,
      favouriteIntervals: DEFAULT_FAVOURITE_INTERVALS,
    })
  })

  it('shows the pinned intervals inline', () => {
    render(<IntervalPicker />)

    const labels = within(bar())
      .getAllByRole('button')
      .map((button) => button.textContent)
    expect(labels).toEqual(['5m', '15m', '1H', '4H', '1D'])
  })

  it('lists every interval in the menu, grouped', () => {
    render(<IntervalPicker />)
    openMenu()

    for (const label of ['1m', '2m', '3m', '30m', '90m', '1W', '1M']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${label}`) })).toBeTruthy()
    }
    expect(screen.getByText('Minutes')).toBeTruthy()
    expect(screen.getByText('Hours')).toBeTruthy()
    expect(screen.getByText('Days')).toBeTruthy()
  })

  it('selects an interval from the menu and closes it', () => {
    render(<IntervalPicker />)
    openMenu()

    fireEvent.click(screen.getByRole('button', { name: /^90m/ }))

    expect(useWorkspace.getState().interval).toBe('90m')
    expect(screen.queryByText('Minutes')).toBeNull()
  })

  it('keeps an unpinned current interval visible in the bar', () => {
    // Otherwise the strip reads as though nothing is selected: the chart is
    // on 90m and every button in the bar is off.
    useWorkspace.setState({ interval: '90m' })
    render(<IntervalPicker />)

    const current = within(bar()).getByRole('button', { name: '90m' })
    expect(current.getAttribute('aria-pressed')).toBe('true')
  })

  it('drops the borrowed slot again once you move off it', () => {
    useWorkspace.setState({ interval: '90m' })
    const view = render(<IntervalPicker />)
    expect(within(bar()).queryByRole('button', { name: '90m' })).toBeTruthy()

    act(() => useWorkspace.setState({ interval: '1h' }))
    view.rerender(<IntervalPicker />)

    expect(within(bar()).queryByRole('button', { name: '90m' })).toBeNull()
  })

  it('pins an interval into the bar', () => {
    render(<IntervalPicker />)
    openMenu()

    fireEvent.click(screen.getByRole('button', { name: 'Pin 1W' }))

    expect(useWorkspace.getState().favouriteIntervals).toContain('1w')
    // Pinning is not choosing: the chart stays where it was.
    expect(useWorkspace.getState().interval).toBe('1h')
  })

  it('states how far back each interval reaches', () => {
    // Every interval is bounded by what the backend can store, and finding
    // that out by picking one and watching the range collapse reads as a bug.
    render(<IntervalPicker />)
    openMenu()

    expect(screen.getByRole('button', { name: /^1m\b.*7d history/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^1D.*2y history/ })).toBeTruthy()
  })
})
