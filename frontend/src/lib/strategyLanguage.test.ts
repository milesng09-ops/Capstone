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
    const read = interpret('long, but only during the London session')

    expect(read.rules.direction).toBe('long')
    expect(read.unread).toEqual(['but only during the London session'])
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
