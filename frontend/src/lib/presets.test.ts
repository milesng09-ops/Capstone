/**
 * Presets have to hang together.
 *
 * A preset is the first thing anyone loads, so an incoherent one -- a
 * condition without the target it was written for, a reward floor of zero on
 * a mode that needs one -- teaches the wrong thing about what the settings
 * mean before the user has changed anything.
 */

import { describe, expect, it } from 'vitest'

import { STRATEGY_PRESETS, findPreset } from '@/lib/presets'

describe('every preset', () => {
  it('has a unique id', () => {
    const ids = STRATEGY_PRESETS.map((preset) => preset.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('is findable by its id', () => {
    for (const preset of STRATEGY_PRESETS) {
      expect(findPreset(preset.id)).toBe(preset)
    }
  })

  it('says what it is and why', () => {
    for (const preset of STRATEGY_PRESETS) {
      expect(preset.summary.length).toBeGreaterThan(0)
      expect(preset.rationale.length).toBeGreaterThan(0)
    }
  })

  it('never ships a win rate', () => {
    // The whole argument of the app is that a result has to be earned on the
    // data. A preset advertising one would undercut it before the first run.
    for (const preset of STRATEGY_PRESETS) {
      expect(`${preset.summary} ${preset.rationale}`).not.toMatch(/\bwin rate of\b/i)
    }
  })

  it('sets a positive reward floor wherever the target is liquidity', () => {
    // With the floor at zero the nearest shelf is taken however close it is,
    // and a target two points away fills nearly every time -- a flattering
    // win rate for a strategy that loses money.
    for (const preset of STRATEGY_PRESETS) {
      if (preset.rules?.take_profit_type !== 'liquidity') continue
      expect(preset.rules.take_profit_value).toBeGreaterThan(0)
    }
  })
})

describe('the liquidity sweep preset', () => {
  const preset = findPreset('liquidity-sweep')

  it('exists', () => {
    expect(preset).toBeDefined()
  })

  it('uses liquidity on both sides of the trade', () => {
    // The shelf behind the entry is the trigger, the shelf in front is the
    // target. Either alone is a different idea.
    expect(preset?.detectors?.require_liquidity_sweep).toBe(true)
    expect(preset?.rules?.take_profit_type).toBe('liquidity')
  })

  it('stops at the extreme of the pattern, not a fixed percentage', () => {
    // The trade is wrong exactly when the level that was swept gives way
    // again, which is a price on the chart rather than a distance.
    expect(preset?.rules?.stop_loss_type).toBe('pattern_extreme')
  })

  it('requires the sweep to be recent', () => {
    // A sweep from three sessions ago is not why this trade is being taken.
    expect(preset?.detectors?.within_bars).toBeLessThanOrEqual(10)
  })
})
