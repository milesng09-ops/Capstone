/**
 * Reading a written strategy.
 *
 * The two things worth protecting are the two ways this can mislead: reading
 * a phrase as the wrong setting, and quietly dropping one it has never heard
 * of. The second is the dangerous one -- a description whose most important
 * clause went unread produces a strategy that looks filled in and is not the
 * one that was asked for.
 */

import { describe, expect, it } from 'vitest'

import { interpret, strategyFrom } from '@/lib/strategyLanguage'
import { DEFAULT_TRADE_RULES } from '@/types/backtest'

const settings = (text: string) => interpret(text).understood.map((item) => item.setting)

describe('direction', () => {
  it.each(['go long', 'buy the retrace', 'bullish continuation'])('reads %s as long', (text) => {
    expect(interpret(text).rules.direction).toBe('long')
  })

  it.each(['short it', 'sell the high', 'bearish reversal'])('reads %s as short', (text) => {
    expect(interpret(text).rules.direction).toBe('short')
  })

  it('does not find a direction in a sentence without one', () => {
    expect(interpret('enter inside a fair value gap').rules.direction).toBeUndefined()
  })

  it('is not fooled by a longer word', () => {
    // "belonging" contains "long"; word boundaries are what stop that.
    expect(interpret('belonging to the range').rules.direction).toBeUndefined()
  })
})

describe('stops', () => {
  it('reads a percentage stop either way round', () => {
    expect(interpret('1% stop').rules).toMatchObject({
      stop_loss_type: 'percentage',
      stop_loss_value: 1,
    })
    expect(interpret('stop at 0.5%').rules).toMatchObject({
      stop_loss_type: 'percentage',
      stop_loss_value: 0.5,
    })
  })

  it('reads an ATR stop', () => {
    expect(interpret('stop of 1.5 ATR').rules).toMatchObject({
      stop_loss_type: 'atr_multiple',
      stop_loss_value: 1.5,
    })
  })

  it('reads a stop placed at the pattern extreme', () => {
    expect(interpret('stop below the swing low').rules).toMatchObject({
      stop_loss_type: 'pattern_extreme',
    })
  })
})

describe('targets', () => {
  it('reads an R multiple', () => {
    expect(interpret('target 2R').rules).toMatchObject({
      take_profit_type: 'risk_reward',
      take_profit_value: 2,
    })
  })

  it('reads a ratio written with a colon', () => {
    expect(interpret('aim for 3:1').rules).toMatchObject({
      take_profit_type: 'risk_reward',
      take_profit_value: 3,
    })
  })

  it('reads a percentage target', () => {
    expect(interpret('take profit 1.5%').rules).toMatchObject({
      take_profit_type: 'percentage',
      take_profit_value: 1.5,
    })
  })

  it('does not read a percentage stop as a target', () => {
    // The clause names one thing; reading it as both would silently set a
    // target nobody asked for.
    expect(interpret('1% stop').rules.take_profit_type).toBeUndefined()
  })
})

describe('conditions', () => {
  it('recognises the three detectors by the words traders use', () => {
    expect(interpret('only inside an FVG').detectors.require_fair_value_gap).toBe(true)
    expect(interpret('needs an SMT divergence').detectors.require_smt_divergence).toBe(true)
    expect(interpret('after a structure break').detectors.require_swing_point).toBe(true)
  })

  it('reads how recent a condition must be', () => {
    expect(interpret('divergence within 5 bars').detectors).toMatchObject({
      require_smt_divergence: true,
      within_bars: 5,
    })
  })
})

describe('the search', () => {
  it('reads a match limit', () => {
    expect(interpret('top 40 matches').search.maximumMatches).toBe(40)
  })

  it('reads a similarity threshold written either way', () => {
    expect(interpret('similarity above 0.7').search.minimumSimilarity).toBeCloseTo(0.7)
    expect(interpret('similarity at least 70').search.minimumSimilarity).toBeCloseTo(0.7)
  })

  it('converts a lookback into days', () => {
    expect(interpret('over the last 6 months').search.lookbackDays).toBe(180)
    expect(interpret('past 2 weeks').search.lookbackDays).toBe(14)
  })

  it('picks up the markets named anywhere in the text', () => {
    expect(interpret('long NQ against ES').search.searchSymbols).toEqual(['ES', 'NQ'])
  })
})

describe('what it could not read', () => {
  it('reports a clause it has no rule for', () => {
    // This used to be the London session, which the grammar has since learned.
    // The example has to be something genuinely outside it, or the test
    // passes for the wrong reason the moment the vocabulary grows.
    const read = interpret('long, but only when the VIX is under 20')

    expect(read.rules.direction).toBe('long')
    expect(read.unread).toEqual(['but only when the VIX is under 20'])
  })

  it('reports nothing unread when every clause landed', () => {
    expect(interpret('long, 1% stop, 2R').unread).toEqual([])
  })

  it('counts a clause that only named a market as read', () => {
    expect(interpret('on ES, long').unread).toEqual([])
  })

  it('treats an empty description as nothing asked for', () => {
    const read = interpret('   ')

    expect(read.understood).toEqual([])
    expect(read.unread).toEqual([])
  })
})

describe('the account it gives', () => {
  it('quotes the words responsible for each setting', () => {
    const read = interpret('go long with a 1% stop and target 2R')

    expect(read.understood).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ setting: 'Direction', value: 'Long' }),
        expect.objectContaining({ setting: 'Stop loss', value: '1% from entry' }),
        expect.objectContaining({ setting: 'Target', value: '2x the risk' }),
      ]),
    )
    for (const item of read.understood) {
      expect(item.phrase.length).toBeGreaterThan(0)
    }
  })

  it('names every setting a full description touches', () => {
    const read = settings(
      'Short ES inside a fair value gap within 5 bars, stop 1%, 2R, hold 12 bars, ' +
        'top 30 matches over the last 90 days',
    )

    expect(new Set(read)).toEqual(
      new Set([
        'Markets',
        'Direction',
        'Condition',
        'Condition age',
        'Stop loss',
        'Target',
        'Maximum hold',
        'Matches',
        'Lookback',
      ]),
    )
  })
})

describe('the strategy it produces', () => {
  it('fills the rest from the defaults rather than from the form', () => {
    // A description replaces the strategy. Merging into whatever was there
    // would make the result depend on what had been tried before it.
    const { rules } = strategyFrom(interpret('short, 2% stop'))

    expect(rules.direction).toBe('short')
    expect(rules.stop_loss_value).toBe(2)
    expect(rules.fee_percent).toBe(DEFAULT_TRADE_RULES.fee_percent)
    expect(rules.maximum_holding_bars).toBe(DEFAULT_TRADE_RULES.maximum_holding_bars)
  })
})

describe('liquidity', () => {
  it.each([
    'sweep the lows then go long',
    'after a liquidity sweep',
    'once the equal highs are taken',
    'price took out the lows',
    'a stop hunt below the shelf',
  ])('reads %s as a sweep condition', (text) => {
    expect(interpret(text).detectors.require_liquidity_sweep).toBe(true)
  })

  it.each(['target liquidity', 'aim for the next pool', 'take profit at the shelf'])(
    'reads %s as a liquidity target',
    (text) => {
      expect(interpret(text).rules.take_profit_type).toBe('liquidity')
    },
  )

  it('keeps the trigger and the target apart', () => {
    // They share a vocabulary and are different settings. Naming the sweep
    // must not silently move the exit.
    const swept = interpret('long after the lows are swept')
    expect(swept.detectors.require_liquidity_sweep).toBe(true)
    expect(swept.rules.take_profit_type).toBeUndefined()

    const aimed = interpret('long, target liquidity')
    expect(aimed.rules.take_profit_type).toBe('liquidity')
    expect(aimed.detectors.require_liquidity_sweep).toBeUndefined()
  })

  it('reads both when the sentence asks for both', () => {
    const both = interpret('long after a liquidity sweep, target the next pool')
    expect(both.detectors.require_liquidity_sweep).toBe(true)
    expect(both.rules.take_profit_type).toBe('liquidity')
  })

  it('does not read a sweep out of an unrelated sentence', () => {
    expect(interpret('long inside a fair value gap').detectors.require_liquidity_sweep)
      .toBeUndefined()
  })
})

describe('liquidity, the phrases the app itself teaches', () => {
  it('reads the vocabulary the UI uses for a target', () => {
    // The panel says "the nearest shelf of equal highs" and every row in the
    // liquidity list is labelled "Equal highs". Writing the app's own words
    // must not change the entry condition instead.
    for (const text of [
      'target the equal highs',
      'take profit at the equal highs',
      'aim for the equal lows',
      'tp the next pool',
    ]) {
      const read = interpret(text)
      expect(read.rules.take_profit_type, text).toBe('liquidity')
      expect(read.detectors.require_liquidity_sweep, text).toBeUndefined()
    }
  })

  it('reads a sweep in the passive voice', () => {
    // The liquidity-sweep preset's own summary is written this way.
    for (const text of [
      'Enter after the lows are taken',
      'once the equal highs are swept',
      'long when liquidity is taken',
      'enter on a sweep of the lows',
      'enter after the sweep',
    ]) {
      expect(interpret(text).detectors.require_liquidity_sweep, text).toBe(true)
    }
  })

  it('does not read a bare noun as a sweep', () => {
    // A sweep is an event. Naming the level is not claiming it was taken.
    expect(interpret('I trade equal highs').detectors.require_liquidity_sweep)
      .toBeUndefined()
  })

  it('treats a reward number as the floor, not a competing target', () => {
    // Both orderings, because rules run clause by clause and neither is
    // canonical. This is the natural sentence for the shipped preset.
    const after = interpret(
      'Long after the equal lows are swept, target the next shelf of highs, minimum 1.5R',
    )
    expect(after.rules.take_profit_type).toBe('liquidity')
    expect(after.rules.take_profit_value).toBe(1.5)
    expect(after.detectors.require_liquidity_sweep).toBe(true)

    const before = interpret('long, 1.5R, target the next liquidity pool')
    expect(before.rules.take_profit_type).toBe('liquidity')
    expect(before.rules.take_profit_value).toBe(1.5)
  })

  it('still reads a plain R target when no pool is named', () => {
    const plain = interpret('long, 2R')
    expect(plain.rules.take_profit_type).toBe('risk_reward')
    expect(plain.rules.take_profit_value).toBe(2)
  })

  it('reports the reward as a floor once the target is a pool', () => {
    // The account of what was understood has to match what was set, or it is
    // the quiet-disagreement failure this module exists to prevent.
    const read = interpret('target the next pool, minimum 1.5R')
    const target = read.understood.filter((item) => item.setting.includes('reward'))
    expect(target).toHaveLength(1)
    expect(target[0].value).toContain('At least 1.5')
  })

  it('round-trips the shipped preset summary', () => {
    const read = interpret('Enter after the lows are taken, target the next shelf of highs.')
    expect(read.detectors.require_liquidity_sweep).toBe(true)
    expect(read.rules.take_profit_type).toBe('liquidity')
    expect(read.unread).toHaveLength(0)
  })
})

describe('the gap midpoint', () => {
  it.each([
    'enter at consequent encroachment',
    'wait for the middle of the gap',
    'long from the gap midpoint',
    'enter at 50% of the gap',
  ])('reads %s as the midpoint condition', (text) => {
    const read = interpret(text)
    expect(read.detectors.gap_past_midpoint).toBe(true)
    // Narrowing a condition that is off would mean nothing, so it turns the
    // gap requirement on too.
    expect(read.detectors.require_fair_value_gap).toBe(true)
  })

  it('leaves a plain gap entry at the whole zone', () => {
    const read = interpret('enter inside a fair value gap')
    expect(read.detectors.require_fair_value_gap).toBe(true)
    expect(read.detectors.gap_past_midpoint).toBeUndefined()
  })
})

describe('the trade logic added after the first grammar', () => {
  it('reads a higher-timeframe bias', () => {
    expect(interpret('long with the 4h bias').detectors.require_higher_timeframe_bias).toBe(
      true,
    )
    expect(interpret('in line with the daily').detectors.require_higher_timeframe_bias).toBe(
      true,
    )
  })

  it('does not turn the bias on for a bare direction', () => {
    // "bullish" sets the direction. Reading it as a demand for a higher
    // timeframe to agree would add a condition nobody asked for, and the
    // run would come back with far fewer trades than the words implied.
    expect(interpret('bullish setup off a gap').detectors.require_higher_timeframe_bias)
      .toBeUndefined()
  })

  it('reads a reaction at the level', () => {
    expect(interpret('long on a strong rejection').detectors.require_reaction).toBe(true)
    expect(interpret('enter after a long lower wick').detectors.require_reaction).toBe(true)
  })

  it('reads the two entries off a level as different entries', () => {
    expect(interpret('long into the OTE').detectors.entry_model).toBe('fib_retrace')
    expect(interpret('buy the fib retracement').detectors.entry_model).toBe('fib_retrace')
    expect(interpret('take it straight off the level').detectors.entry_model).toBe(
      'immediate',
    )
  })

  it('reads every session a clause names, not just the first', () => {
    // The rule is applied once per clause, so one that took only its own
    // match would quietly narrow the filter to London.
    expect(interpret('london or new york am only').detectors.sessions).toEqual([
      'london',
      'new_york_am',
    ])
  })

  it('keeps sessions in the canonical order however they were typed', () => {
    expect(interpret('new york pm and london').detectors.sessions).toEqual([
      'london',
      'new_york_pm',
    ])
  })

  it('tells the am and pm sessions apart', () => {
    expect(interpret('ny pm only').detectors.sessions).toEqual(['new_york_pm'])
    expect(interpret('the new york open').detectors.sessions).toEqual(['new_york_am'])
  })

  it('leaves the sessions alone when none is named', () => {
    expect(interpret('long, 1% stop').detectors.sessions).toBeUndefined()
  })

  it('reads a full description into every part of it', () => {
    const read = interpret(
      'long into the fib retracement during london with the daily bias, 1% stop, 2R',
    )

    expect(read.detectors.entry_model).toBe('fib_retrace')
    expect(read.detectors.sessions).toEqual(['london'])
    expect(read.detectors.require_higher_timeframe_bias).toBe(true)
    expect(read.rules.direction).toBe('long')
    expect(read.unread).toEqual([])
  })
})
