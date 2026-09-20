/**
 * The two ways in that are not a blank form.
 *
 * What has to hold: a preset lands on the form as itself rather than merged
 * into whatever was there, and the description route reports both what it
 * set and what it could not read. The second is the one that can mislead --
 * a description whose most important clause went unread produces a strategy
 * that looks filled in and is not the one that was asked for.
 */

import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'

import { StrategyStart } from '@/components/panels/StrategyStart'
import { useWorkspace } from '@/store/workspace'
import {
  DEFAULT_DETECTOR_FILTERS,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_TRADE_RULES,
} from '@/types/backtest'

function open() {
  render(<StrategyStart />)
  const toggle = screen.getByRole('button', { name: /Start from/ })
  fireEvent.click(toggle)
}

function describeAs(text: string) {
  fireEvent.change(screen.getByLabelText('Strategy description'), { target: { value: text } })
  fireEvent.click(screen.getByRole('button', { name: /Read it/ }))
}

describe('StrategyStart', () => {
  beforeEach(() => {
    useWorkspace.setState({
      rules: DEFAULT_TRADE_RULES,
      search: DEFAULT_SEARCH_CONFIG,
      detectors: DEFAULT_DETECTOR_FILTERS,
    })
  })

  it('lists the presets with a line saying what each is', () => {
    open()

    expect(screen.getByRole('button', { name: /Gap continuation/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /SMT divergence reversal/ })).toBeTruthy()
  })

  it('loads a preset onto the form', () => {
    open()

    fireEvent.click(screen.getByRole('button', { name: /Gap continuation/ }))

    const state = useWorkspace.getState()
    expect(state.detectors.require_fair_value_gap).toBe(true)
    expect(state.rules.take_profit_value).toBe(2)
  })

  it('replaces the strategy rather than merging into it', () => {
    // Otherwise the result depends on the order presets were clicked in, and
    // "Gap continuation" names an arrangement nobody could reconstruct.
    open()

    fireEvent.click(screen.getByRole('button', { name: /Gap continuation/ }))
    fireEvent.click(screen.getByRole('button', { name: /Patient swing/ }))

    const state = useWorkspace.getState()
    expect(state.detectors.require_fair_value_gap).toBe(false)
    expect(state.rules.stop_loss_value).toBe(2)
  })

  it('explains a preset once it is chosen', () => {
    open()

    fireEvent.click(screen.getByRole('button', { name: /Volatility scalp/ }))

    expect(screen.getByText(/volatility the market actually has/)).toBeTruthy()
  })

  it('reads a written description onto the form', () => {
    open()

    describeAs('short ES, 2% stop, 3R')

    const state = useWorkspace.getState()
    expect(state.rules.direction).toBe('short')
    expect(state.rules.stop_loss_value).toBe(2)
    expect(state.rules.take_profit_value).toBe(3)
  })

  it('quotes the words that set each field', () => {
    open()

    describeAs('go long with a 1% stop')

    expect(screen.getByText('Set from your description')).toBeTruthy()
    expect(screen.getByText(/“1% stop”/)).toBeTruthy()
  })

  it('says plainly what it could not read', () => {
    open()

    // The London session was the example here until the grammar learned it.
    describeAs('long, but only when the VIX is under 20')

    expect(screen.getByText('Not understood')).toBeTruthy()
    // Quoted, which also keeps this off the textarea still holding the text.
    expect(screen.getByText('“but only when the VIX is under 20”')).toBeTruthy()
  })

  it('says so when a description named nothing at all', () => {
    open()

    describeAs('do something clever')

    expect(screen.getByText(/Nothing in that described a setting/)).toBeTruthy()
  })

  it('clears the preset explanation once a description takes over', () => {
    // The two routes set the same fields; leaving both accounts on screen
    // would describe a form that matches neither.
    open()

    fireEvent.click(screen.getByRole('button', { name: /Volatility scalp/ }))
    describeAs('long, 1% stop')

    expect(screen.queryByText(/volatility the market actually has/)).toBeNull()
  })

  it('does not offer to read an empty description', () => {
    open()

    expect(screen.getByRole('button', { name: /Read it/ })).toHaveProperty('disabled', true)
  })
})
