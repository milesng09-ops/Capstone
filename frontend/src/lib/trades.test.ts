/**
 * Turning a simulated trade back into chart objects.
 *
 * The geometry and the filtering are tested here rather than through the
 * canvas: what a position box covers and which detections count as evidence
 * are questions about numbers, and a headless canvas paints nothing to assert
 * against anyway.
 */

import { describe, expect, it } from 'vitest'

import {
  collectEvidence,
  evidenceWindow,
  findMatch,
  hasEvidence,
  hitTestPositions,
  positionBox,
  tradesForSymbol,
  withinWindow,
} from '@/lib/trades'
import type { PatternMatch, Trade } from '@/types/backtest'
import type { FairValueGap, IctAnalysis, SmtDivergence, SwingPoint } from '@/types/ict'

const HOUR = 3_600_000
const T0 = 1_780_000_000_000

function trade(overrides: Partial<Trade> = {}): Trade {
  return {
    id: 'trade-1',
    trade_number: 1,
    pattern_match_id: 'match-1',
    symbol: 'NQ',
    direction: 'long',
    entry_time: T0 + 10 * HOUR,
    exit_time: T0 + 14 * HOUR,
    entry_price: 100,
    exit_price: 104,
    stop_price: 98,
    target_price: 104,
    gross_return: 4,
    fees: 0.04,
    net_return: 3.96,
    exit_reason: 'take_profit',
    holding_bars: 4,
    similarity_score: 0.82,
    same_bar_ambiguity: false,
    ...overrides,
  }
}

function match(overrides: Partial<PatternMatch> = {}): PatternMatch {
  return {
    id: 'match-1',
    symbol: 'NQ',
    interval: '1h',
    start_time: T0 + 4 * HOUR,
    end_time: T0 + 9 * HOUR,
    similarity_score: 0.82,
    euclidean_distance: 0.4,
    entry_price: 100,
    rank: 1,
    normalized_series: null,
    outcome: 'take_profit',
    net_return: 3.96,
    ...overrides,
  }
}

function gap(overrides: Partial<FairValueGap> = {}): FairValueGap {
  return {
    symbol: 'NQ',
    direction: 'bullish',
    time: T0,
    start_time: T0,
    end_time: T0 + 3 * HOUR,
    bottom: 95,
    top: 97,
    midpoint: 96,
    size: 2,
    size_percent: 0.2,
    mitigated: false,
    mitigated_time: null,
    filled: false,
    filled_time: null,
    penetration: 0,
    ...overrides,
  }
}

function swing(time: number, confirmed = time): SwingPoint {
  return { symbol: 'NQ', kind: 'high', time, price: 105, confirmed_time: confirmed, strength: 2 }
}

function divergence(start: number, end: number): SmtDivergence {
  return {
    kind: 'high',
    bias: 'bearish',
    primary_symbol: 'NQ',
    reference_symbol: 'ES',
    start_time: start,
    end_time: end,
    primary_start_price: 100,
    primary_end_price: 101,
    reference_start_price: 50,
    reference_end_price: 49,
    leading_symbol: 'NQ',
    lagging_symbol: 'ES',
    validity: 'swing_pair',
    valid: true,
    confirmed_time: end,
    inside_fair_value_gap: false,
    fair_value_gap_time: null,
    strength: 2,
    separation_bars: 5,
  }
}

function analysis(overrides: Partial<IctAnalysis> = {}): IctAnalysis {
  return {
    symbol: 'NQ',
    interval: '1h',
    from_time: T0,
    to_time: T0 + 100 * HOUR,
    provider: 'demo',
    bars_analysed: 100,
    swing_strength: 2,
    reference_symbols: ['ES'],
    swing_points: [],
    fair_value_gaps: [],
    smt_divergences: [],
    warnings: [],
    ...overrides,
  }
}

describe('positionBox', () => {
  it('spans the holding period, so the box width is the length of the trade', () => {
    const box = positionBox(trade())
    expect(box.from).toBe(T0 + 10 * HOUR)
    expect(box.to).toBe(T0 + 14 * HOUR)
  })

  it('orders the ends even when a trade exits before it enters', () => {
    // Not something the engine produces, but a box drawn right-to-left would
    // be invisible rather than wrong-looking, which is harder to notice.
    const box = positionBox(trade({ entry_time: T0 + 5 * HOUR, exit_time: T0 + HOUR }))
    expect(box.from).toBeLessThan(box.to)
  })

  it('reads the outcome from the net return, not the exit reason', () => {
    // A take-profit exit still loses money if the fees outweigh the move.
    expect(positionBox(trade({ net_return: -0.2 })).won).toBe(false)
    expect(positionBox(trade({ net_return: 0.2 })).won).toBe(true)
  })

  it('marks the direction so risk and reward land on the right sides', () => {
    expect(positionBox(trade()).isLong).toBe(true)
    expect(positionBox(trade({ direction: 'short' })).isLong).toBe(false)
  })
})

describe('tradesForSymbol', () => {
  it('keeps only the trades taken on that instrument', () => {
    const trades = [trade(), trade({ id: 'b', symbol: 'ES' })]
    expect(tradesForSymbol(trades, 'NQ').map((item) => item.id)).toEqual(['trade-1'])
    expect(tradesForSymbol(trades, 'ES').map((item) => item.id)).toEqual(['b'])
  })
})

describe('evidenceWindow', () => {
  it('starts at the matched pattern, which is what the engine acted on', () => {
    const window = evidenceWindow(trade(), match())
    expect(window.start_time).toBe(T0 + 4 * HOUR)
    expect(window.end_time).toBe(T0 + 14 * HOUR)
  })

  it('falls back to the trade itself when the match is gone', () => {
    const window = evidenceWindow(trade(), null)
    expect(window.start_time).toBe(T0 + 10 * HOUR)
    expect(window.end_time).toBe(T0 + 14 * HOUR)
  })

  it('finds the match a trade came from', () => {
    expect(findMatch([match({ id: 'other' }), match()], trade())?.id).toBe('match-1')
    expect(findMatch([], trade())).toBeNull()
    expect(findMatch([match()], null)).toBeNull()
  })
})

describe('collectEvidence', () => {
  const window = { start_time: T0 + 4 * HOUR, end_time: T0 + 14 * HOUR }

  it('is empty, but keeps its window, without an analysis', () => {
    const evidence = collectEvidence(undefined, window)
    expect(hasEvidence(evidence)).toBe(false)
    expect(evidence.window).toEqual(window)
  })

  it('keeps an unfilled gap that opened before the window', () => {
    // It was never traded through, so it is still a live level at entry.
    const evidence = collectEvidence(
      analysis({ fair_value_gaps: [gap({ start_time: T0, end_time: T0 + HOUR })] }),
      window,
    )
    expect(evidence.gaps).toHaveLength(1)
  })

  it('drops a gap that was filled before the window opened', () => {
    const evidence = collectEvidence(
      analysis({
        fair_value_gaps: [
          gap({ filled: true, filled_time: T0 + 2 * HOUR, end_time: T0 + 2 * HOUR }),
        ],
      }),
      window,
    )
    expect(evidence.gaps).toHaveLength(0)
  })

  it('drops a gap that opens after the window closes', () => {
    const evidence = collectEvidence(
      analysis({ fair_value_gaps: [gap({ start_time: T0 + 40 * HOUR })] }),
      window,
    )
    expect(evidence.gaps).toHaveLength(0)
  })

  it('keeps swings inside the window', () => {
    const evidence = collectEvidence(
      analysis({ swing_points: [swing(T0 + 6 * HOUR), swing(T0 + 50 * HOUR)] }),
      window,
    )
    expect(evidence.swings).toHaveLength(1)
  })

  it('drops a swing that had not been confirmed by the end of the window', () => {
    // Showing it would credit the engine with information it did not have.
    const evidence = collectEvidence(
      analysis({ swing_points: [swing(T0 + 13 * HOUR, T0 + 30 * HOUR)] }),
      window,
    )
    expect(evidence.swings).toHaveLength(0)
  })

  it('keeps a divergence that merely overlaps the window', () => {
    const evidence = collectEvidence(
      analysis({ smt_divergences: [divergence(T0, T0 + 5 * HOUR)] }),
      window,
    )
    expect(evidence.divergences).toHaveLength(1)
    expect(hasEvidence(evidence)).toBe(true)
  })
})

describe('hitTestPositions', () => {
  const boxes = [
    { id: 'a', left: 10, right: 60, top: 20, bottom: 80 },
    { id: 'b', left: 40, right: 90, top: 30, bottom: 70 },
  ]

  it('finds the box under the pointer', () => {
    expect(hitTestPositions(boxes, 20, 30)).toBe('a')
    expect(hitTestPositions(boxes, 80, 50)).toBe('b')
  })

  it('returns the topmost where two overlap', () => {
    // Later trades paint over earlier ones, so the later one is what was hit.
    expect(hitTestPositions(boxes, 50, 50)).toBe('b')
  })

  it('returns nothing outside every box', () => {
    expect(hitTestPositions(boxes, 5, 5)).toBeNull()
    expect(hitTestPositions([], 20, 30)).toBeNull()
  })
})

describe('withinWindow', () => {
  it('treats a missing window as no restriction at all', () => {
    expect(withinWindow(null, T0)).toBe(true)
  })

  it('includes both ends', () => {
    const window = { start_time: T0, end_time: T0 + HOUR }
    expect(withinWindow(window, T0)).toBe(true)
    expect(withinWindow(window, T0 + HOUR)).toBe(true)
    expect(withinWindow(window, T0 - 1)).toBe(false)
  })
})
