/**
 * Turning a written description into a strategy.
 *
 * Miles asked for an AI strategy builder that reads a description or a set of
 * example trades. This is the first half, and it is worth being plain about
 * what it is: **a grammar, not a model.** Nothing here calls a language
 * model. It recognises the phrases traders actually write -- "long, 1% stop,
 * 2R, only in a fair value gap" -- and maps each to the setting it names.
 *
 * That choice is the point rather than a shortcut. This app's whole argument
 * is that a result has to show its working, and a form filled in by something
 * that cannot say *why* is the same defect one step earlier: you would be
 * running a backtest on settings you did not choose and cannot audit. So
 * every field this sets is reported with the words that set it, and every
 * phrase it did not understand is reported too -- because the dangerous
 * failure is not "it refused", it is "it quietly ignored the half of the
 * sentence that mattered".
 *
 * A model can be put behind this later. What it would have to produce is
 * exactly what `interpret` produces now, which is the useful part: a patch, a
 * line-by-line account of where each value came from, and an honest list of
 * what went unread.
 */

import {
  DEFAULT_DETECTOR_FILTERS,
  DEFAULT_SEARCH_CONFIG,
  DEFAULT_TRADE_RULES,
  MAX_PATTERN_MATCHES,
  type DetectorFilters,
  type Direction,
  type SearchConfig,
  type TradeRules,
} from '@/types/backtest'
import { SESSION_KEYS, SESSION_LABELS, type SessionKey } from '@/types/backtest'
import { SYMBOLS, type SymbolKey } from '@/types/market'

/** One thing the description asked for, and the words that asked for it. */
export interface Understood {
  /** The matched text, quoted back so the user can see what was read. */
  phrase: string
  /** Human name of the setting, e.g. "Stop loss". */
  setting: string
  /** Human form of the value, e.g. "1% below entry". */
  value: string
}

export interface Interpretation {
  rules: Partial<TradeRules>
  search: Partial<SearchConfig>
  detectors: Partial<DetectorFilters>
  understood: Understood[]
  /**
   * What it could not read: clauses with no recognised instruction in them,
   * and phrases it recognised but could not apply as written.
   *
   * Reported rather than dropped: a description that mentions a condition
   * this grammar has never heard of produces a strategy that is missing it,
   * and the user has to be able to see that rather than discover it in a
   * result. The phrases are the same failure inside a clause that was
   * otherwise read -- "long ES, short NQ" names two directions for a form
   * that holds one, and "the daily bias" names a timeframe this cannot set --
   * so the words that set nothing are quoted on their own.
   */
  unread: string[]
}

/** A stretch of a clause, as offsets: start inclusive, end exclusive. */
type Span = [number, number]

/**
 * What the words around a phrase do to it.
 *
 * `unclear` is an answer in its own right rather than a guess at one of the
 * other two. "Never trade after a sweep" and "don't enter until a sweep" are
 * built the same way and mean opposite things, and a reader that cannot tell
 * them apart has to say so instead of picking one.
 */
type Polarity = 'on' | 'off' | 'unclear'

/** One place a rule matched in a clause. */
interface Hit {
  match: RegExpMatchArray
  start: number
  end: number
  /** The parts of the match the rule owns; see `Rule.owns`. */
  spans: Span[]
  polarity: Polarity
  /** The phrase together with any negation of it, as it is quoted back. */
  quoted: string
}

/** One clause on its way through the grammar. */
interface Clause {
  /** As typed, for quoting back a clause nothing in which was read. */
  text: string
  /** What the rules see: lower case, and a leading-dot decimal given its zero. */
  lower: string
  read: boolean
  /** Phrases in it that were recognised and could not be applied. */
  unread: string[]
}

/** A word naming a direction, held until the whole description has been read. */
interface DirectionWord {
  direction: Direction
  /** A trade ("short", "buy") rather than a description of the market ("bullish"). */
  verb: boolean
  negated: boolean
  phrase: string
  quoted: string
  clause: Clause
  /** Where its line goes in the account, so the account keeps the text's order. */
  at: number
}

/** What one reading builds up as it goes, shared by every rule. */
interface Reading {
  into: Interpretation
  clause: Clause
  /** What each condition has been asked to be so far, so a contradiction shows. */
  stances: Map<string, boolean>
  directions: DirectionWord[]
  /** Sessions the text said to stay out of, checked once the filter is known. */
  avoided: { sessions: SessionKey[]; clause: Clause; quoted: string }[]
}

interface Rule {
  /** What to look for. Must have at least one capture group when numeric. */
  pattern: RegExp
  /**
   * The parts of a match the rule owns, as offsets into it, when that is less
   * than all of it.
   *
   * A few patterns reach across filler to join a keyword to its value --
   * "hold [inside the gap for] 12 bars". The filler is not theirs: owning it
   * would take "the gap" away from the gap rule, and a condition would go
   * missing because a holding period was written around it.
   */
  owns?: (match: RegExpMatchArray) => Span[]
  /** Reads the first place the rule matched in a clause. */
  apply?: (hit: Hit, reading: Reading) => Understood | null
  /** Reads every place it matched, for the rules that weigh one against another. */
  applyAll?: (hits: Hit[], reading: Reading) => Understood | null
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`

function bounded(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

/**
 * Ownership for a pattern that joins a keyword to its value across filler.
 *
 * `head` and `tail` find the two ends in the matched text; the middle is left
 * for the other rules. See `Rule.owns`.
 */
function ends(head: RegExp, tail: RegExp): (match: RegExpMatchArray) => Span[] {
  return (match) => {
    const length = match[0].length
    const front = match[0].match(head)?.[0].length ?? length
    const back = match[0].match(tail)?.[0].length ?? length
    return [
      [0, front],
      [length - back, length],
    ]
  }
}

/** Quote a phrase that was recognised and cannot be applied as written. */
function cannotRead(reading: Reading, phrase: string): null {
  reading.clause.unread.push(phrase)
  return null
}

/**
 * Record what a switch has been asked to be, refusing a contradiction.
 *
 * The first mention stands. A later one that contradicts it -- "inside a
 * gap", then "no gap needed" -- is quoted as unread rather than quietly
 * winning, because nothing about the order says which of the two was meant.
 */
function stand(reading: Reading, key: string, wanted: boolean): boolean {
  const before = reading.stances.get(key)
  if (before !== undefined && before !== wanted) return false
  reading.stances.set(key, wanted)
  return true
}

type Switch =
  | 'require_fair_value_gap'
  | 'gap_past_midpoint'
  | 'require_smt_divergence'
  | 'require_swing_point'
  | 'require_liquidity_sweep'
  | 'require_higher_timeframe_bias'
  | 'require_reaction'

/**
 * A condition, switched the way the words around it ask.
 *
 * Off is written into the patch and into the account rather than left out:
 * "no fair value gap needed" is an instruction, and it should read back as
 * one, not as a clause the grammar could not follow.
 */
function condition(
  hit: Hit,
  reading: Reading,
  key: Switch,
  on: string,
  off: string,
): Understood | null {
  if (hit.polarity === 'unclear') return cannotRead(reading, hit.quoted)
  const wanted = hit.polarity === 'on'
  if (!stand(reading, key, wanted)) return cannotRead(reading, hit.quoted)
  reading.into.detectors[key] = wanted
  return { phrase: hit.quoted, setting: 'Condition', value: wanted ? on : off }
}

/** One of the two entries off a level, asked for or ruled out. */
function entry(
  hit: Hit,
  reading: Reading,
  model: 'fib_retrace' | 'immediate',
  on: string,
  off: string,
): Understood | null {
  if (hit.polarity === 'unclear') return cannotRead(reading, hit.quoted)
  const wanted = hit.polarity === 'on'
  if (!stand(reading, model, wanted)) return cannotRead(reading, hit.quoted)
  const { detectors } = reading.into
  if (wanted) detectors.entry_model = model
  // Ruling one out is not asking for the other: both stay allowed, unless
  // the text has already asked for the other one by name.
  else if (detectors.entry_model === undefined) detectors.entry_model = 'any'
  return { phrase: hit.quoted, setting: 'Entry', value: wanted ? on : off }
}

/**
 * A number of R, applied as the target -- or as the floor under one, because
 * a number of R does not overrule an exit that has already been named.
 *
 * "Target the next shelf of highs, minimum 1.5R" is one instruction, not
 * two competing ones: with a liquidity target, `take_profit_value` *is* the
 * minimum reward. Overwriting the type here produced a plain 1.5R target
 * while the account of what was understood claimed both -- the exact failure
 * this module exists to prevent, and it fired on the most natural sentence
 * for the liquidity preset.
 *
 * Rules are applied clause by clause, so neither ordering is the canonical
 * one and this cannot be fixed by moving rules around.
 */
function reward(into: Interpretation, raw: number, phrase: string): Understood {
  const value = bounded(raw, 0.01, Number.MAX_SAFE_INTEGER)
  const floor = into.rules.take_profit_type === 'liquidity'
  if (!floor) into.rules.take_profit_type = 'risk_reward'
  into.rules.take_profit_value = value
  return {
    phrase,
    setting: floor ? 'Minimum reward' : 'Target',
    value: floor ? `At least ${value}x the risk` : `${value}x the risk`,
  }
}

/**
 * The words around a number of R that say which side of the trade it is on.
 *
 * "Risk 1R to make 3R" names two and only one is a target. R *is* the risk,
 * so a number of it the text attaches to risking is the unit, not an
 * instruction, and of the rest the one attached to a reward word is the
 * target.
 */
const REWARD_BEFORE =
  /\b(?:make|making|target(?:ing)?|reward|profit|tp|for|gain|win|return|minimum|min|least)\s+(?:of\s+|at\s+)?$/
const REWARD_AFTER = /^\s*(?:target|reward|profit|tp|gain)\b/
const RISK_BEFORE = /\b(?:risk|risking)\s+(?:of\s+)?$/
const RISK_AFTER = /^\s*(?:of\s+)?risk\b/

/** "Risk reward", "risk-to-reward", "R:R" and "RR", in either order of the two. */
const RATIO_WORDS = String.raw`(?:risk|reward)(?:\s*[-/:]\s*|\s+)(?:to(?:\s*-\s*|\s+))?(?:reward|risk)|r\s*[:/]\s*r|rr`
const RATIO = String.raw`${NUMBER}\s*(?::|\/|\s+to\s+)\s*${NUMBER}`

/** A timeframe named for a bias, which this reader reports rather than sets. */
const TIMEFRAME = String.raw`daily|weekly|monthly|\d+[\s-]?(?:h|hrs?|hours?)|h\d+`
const BIAS = String.raw`bias|trend|direction|structure`

/** A span of time, as a number and a unit. */
const SPAN = String.raw`${NUMBER}\s*(days?|weeks?|months?|years?)`

/**
 * The killzones a session phrase names.
 *
 * `null` when it names a level rather than a time ("the Asian range"), and
 * `'unknown'` when it names a time that is not one of the killzones ("the
 * London close").
 */
function sessionsNamed(match: RegExpMatchArray): SessionKey[] | 'unknown' | null {
  const [, place, first, second, word] = match
  if (word && /^(?:range|highs?|lows?|time)$/.test(word)) return null
  if (word && /^(?:close|lunch|midnight)$/.test(word)) return 'unknown'
  if (place.startsWith('asia')) return ['asia']
  if (place === 'london') return ['london']
  const halves = [first, second].filter((half) => half !== undefined)
  if (halves.length > 0) {
    return halves.map((half) => (half === 'am' ? 'new_york_am' : 'new_york_pm'))
  }
  if (word === 'afternoon') return ['new_york_pm']
  if (word === 'open' || word === 'morning') return ['new_york_am']
  return ['new_york_am', 'new_york_pm']
}

/**
 * The grammar, in the order it is applied.
 *
 * Which rule *reads* a stretch of text is settled before any of them is
 * applied, by where the matches start -- see `hitsIn` -- so this order no
 * longer decides that. It decides two smaller things: which of two rules
 * writes last when both set the same field from different phrases of one
 * clause, and which rule takes a stretch that two of them match identically.
 */
const RULES: Rule[] = [
  // ---- direction --------------------------------------------------------
  {
    /*
     * Every word that names a direction, settled once the whole text is read.
     *
     * Last-one-wins read "Short NQ when bullish momentum fades" as a long --
     * "bullish" came after "short" -- and "short it, 1% stop, exit if it
     * turns bullish" the same way from another clause. A trade verb is an
     * instruction and an adjective is a description of the market, so a verb
     * anywhere outranks every adjective, and two verbs that disagree ("long
     * ES, short NQ") are reported rather than one of them winning, because
     * the form holds one direction and nothing says which was meant.
     *
     * The lookaheads keep out the nouns built on the same words: a long wick
     * is a candle, buy stops and sell-side liquidity are resting orders, a
     * short squeeze and a sell-off are moves.
     */
    pattern: new RegExp(
      String.raw`\b(?:(?:short(?:s|ing)?|longs?)` +
        String.raw`(?![\s-]+(?:(?:lower|upper)\s+)?(?:wicks?|term|squeeze)\b)` +
        String.raw`|(?:sell(?:s|ing)?|buy(?:s|ing)?)(?![\s-]*(?:side|stops?)\b)(?!-off\b)` +
        String.raw`|bullish|bearish|upside|downside)\b`,
    ),
    applyAll: (hits, reading) => {
      const text = reading.clause.lower
      for (const hit of hits) {
        const word = hit.match[0]
        // "As long as the bias agrees" is a condition, not a trade.
        if (word === 'long' && /\b(?:as|how|so|too)\s+$/.test(text.slice(0, hit.start))) {
          continue
        }
        // "Never short without SMT" rules out shorting without the condition,
        // not shorting: the negation reaches past the verb to what follows it.
        const qualified = /\b(?:without|unless|until|before|except)\b/.test(text.slice(hit.end))
        reading.directions.push({
          direction: /^(?:short|sell|bear|down)/.test(word) ? 'short' : 'long',
          verb: !/(?:ish|side)$/.test(word),
          negated: hit.polarity !== 'on' && !qualified,
          phrase: word,
          quoted: hit.quoted,
          clause: reading.clause,
          at: reading.into.understood.length,
        })
      }
      return null
    },
  },

  // ---- entry ------------------------------------------------------------
  {
    pattern: /\b(next open|next bar|following open|open of the next)\b/,
    apply: (hit, reading) => {
      // Ruled out, it names no entry in particular, so it sets nothing.
      if (hit.polarity !== 'on') return cannotRead(reading, hit.quoted)
      reading.into.rules.entry_type = 'next_open'
      return { phrase: hit.match[0], setting: 'Entry', value: "Next bar's open" }
    },
  },

  // ---- stop -------------------------------------------------------------
  {
    pattern: new RegExp(
      String.raw`\b${NUMBER}\s*(?:x\s*)?atr\b[^.]{0,20}?stop` +
        String.raw`|stop(?![\s-]*hunt)[^.]{0,20}?\b${NUMBER}\s*(?:x\s*)?atr\b`,
    ),
    owns: ends(/^(?:stop|[\d.]+\s*(?:x\s*)?atr)/, /(?:stop|[\d.]+\s*(?:x\s*)?atr)$/),
    apply: ({ match }, { into }) => {
      const value = Number(match[1] ?? match[2])
      into.rules.stop_loss_type = 'atr_multiple'
      into.rules.stop_loss_value = bounded(value, 0.01, Number.MAX_SAFE_INTEGER)
      return { phrase: match[0], setting: 'Stop loss', value: `${into.rules.stop_loss_value} x ATR` }
    },
  },
  {
    /*
     * The level the stop sits behind is part of the stop. "Stop below the
     * swing low" used to set this *and* a swing-point entry condition, the
     * swing rule finding "swing low" inside the phrase and reading it again;
     * owning the level is what keeps it to the one setting it names. "Stop
     * hunt" is the sweep, not a stop.
     */
    pattern:
      /\bstop(?![\s-]*hunt)[^.]{0,24}?\b(pattern (?:low|high|extreme)|swing (?:low|high)|structure)\b/,
    owns: ends(/^stop/, /(?:pattern (?:low|high|extreme)|swing (?:low|high)|structure)$/),
    apply: ({ match }, { into }) => {
      into.rules.stop_loss_type = 'pattern_extreme'
      into.rules.stop_loss_value = 0
      return { phrase: match[0], setting: 'Stop loss', value: 'Beyond the pattern extreme' }
    },
  },
  {
    pattern: new RegExp(String.raw`\b${NUMBER}\s*%\s*stop\b|\bstop(?:[\s-]+loss)?\s*(?:of|at)?\s*${NUMBER}\s*%`),
    apply: ({ match }, { into }) => {
      const value = Number(match[1] ?? match[2])
      into.rules.stop_loss_type = 'percentage'
      into.rules.stop_loss_value = bounded(value, 0.01, Number.MAX_SAFE_INTEGER)
      return { phrase: match[0], setting: 'Stop loss', value: `${into.rules.stop_loss_value}% from entry` }
    },
  },

  // ---- target -----------------------------------------------------------
  {
    /*
     * A ratio written out: "risk reward 1:2", "a 1:3 risk-to-reward".
     *
     * The generic form below read "risk reward 1:2" as a 1R target. It took
     * the first number after the words, which is the risk side of the ratio
     * and nearly always 1, so every sentence written this way came out as
     * the smallest target there is. The words say which number is which:
     * risk first, unless they say reward first.
     */
    pattern: new RegExp(
      String.raw`\b(?:${RATIO_WORDS})(?:\s+ratio)?(?:\s+(?:of|at|is))?\s*[:=]?\s*${RATIO}\b` +
        String.raw`|\b${RATIO}\s+(?:${RATIO_WORDS})\b`,
    ),
    apply: ({ match }, reading) => {
      const [first, second] = match
        .slice(1)
        .filter((part) => part !== undefined)
        .map(Number)
      const rewardFirst = /\breward(?:\s*[-/:]\s*|\s+)(?:to(?:\s*-\s*|\s+))?risk\b/.test(match[0])
      const value = rewardFirst ? first / second : second / first
      // Nothing at risk is not a ratio anyone can trade.
      if (!Number.isFinite(value)) return cannotRead(reading, match[0])
      return reward(reading.into, value, match[0])
    },
  },
  {
    pattern: new RegExp(String.raw`\b${NUMBER}\s*r\b|\brisk[- ]?reward\s*(?:of)?\s*${NUMBER}|\b${NUMBER}\s*:\s*1\b`),
    applyAll: (hits, reading) => {
      const text = reading.clause.lower
      const rewarded = (hit: Hit) =>
        REWARD_BEFORE.test(text.slice(0, hit.start)) || REWARD_AFTER.test(text.slice(hit.end))
      const risked = (hit: Hit) =>
        RISK_BEFORE.test(text.slice(0, hit.start)) || RISK_AFTER.test(text.slice(hit.end))
      const targets = hits.filter((hit) => rewarded(hit) || !risked(hit))
      // Only the unit was named: "risk 1R" sets no target.
      if (targets.length === 0) return null
      const named = targets.filter(rewarded)
      const chosen = targets.length === 1 ? targets[0] : named.length === 1 ? named[0] : null
      if (chosen === null) {
        // "2R or 3R": two targets and nothing to choose between them.
        return cannotRead(reading, text.slice(targets[0].start, targets[targets.length - 1].end))
      }
      const { match } = chosen
      return reward(reading.into, Number(match[1] ?? match[2] ?? match[3]), match[0])
    },
  },
  {
    pattern: new RegExp(String.raw`\b(?:target|take profit|tp)\s*(?:of|at)?\s*${NUMBER}\s*%`),
    apply: ({ match }, { into }) => {
      const value = Number(match[1])
      into.rules.take_profit_type = 'percentage'
      into.rules.take_profit_value = bounded(value, 0.01, Number.MAX_SAFE_INTEGER)
      return { phrase: match[0], setting: 'Target', value: `${into.rules.take_profit_value}% from entry` }
    },
  },

  {
    /*
     * Needs an explicit target verb before the noun, because the trigger and
     * the target are different settings that share a vocabulary.
     *
     * "Equal highs" is in the noun list deliberately: it is the phrase the UI
     * itself teaches -- the panel says "the nearest shelf of equal highs" and
     * every row in the liquidity list is labelled "Equal highs". A user
     * writing the app's own words for the target must not get the entry
     * condition changed instead. The sweep rule below no longer matches a
     * bare noun, which is what keeps the two apart.
     */
    pattern:
      /\b(?:target|targets|targeting|aim(?:ing)?\s+for|take\s+profit(?:\s+at)?|tp)\s*(?:at\s+)?(?:the\s+)?(?:next\s+)?(?:liquidity(?:\s+pool)?|pool|shelf|equal\s+(?:high|low)s?)\b/,
    apply: (hit, reading) => {
      // "Don't target the pool" says what the exit is not, which is no exit.
      if (hit.polarity !== 'on') return cannotRead(reading, hit.quoted)
      const { into } = reading
      const { match } = hit
      into.rules.take_profit_type = 'liquidity'
      // `take_profit_value` is left alone: under a liquidity target it means
      // the minimum reward, and a number elsewhere in the sentence is that
      // floor rather than a competing instruction.
      return {
        phrase: match[0],
        setting: 'Target',
        value: 'The nearest standing liquidity pool',
      }
    },
  },

  // ---- holding ----------------------------------------------------------
  {
    pattern: new RegExp(String.raw`\b(?:hold|exit|close|out)[^.]{0,20}?${NUMBER}\s*bars?\b|\b${NUMBER}\s*bars?\b[^.]{0,12}?(?:max|maximum|at most)`),
    owns: ends(
      /^(?:hold|exit|close|out|[\d.]+\s*bars?)/,
      /(?:[\d.]+\s*bars?|max|maximum|at most)$/,
    ),
    apply: ({ match }, { into }) => {
      const value = bounded(Math.round(Number(match[1] ?? match[2])), 1, 2000)
      into.rules.maximum_holding_bars = value
      return { phrase: match[0], setting: 'Maximum hold', value: `${value} bars` }
    },
  },

  // ---- conditions -------------------------------------------------------
  //
  // Every condition can be ruled out as well as asked for -- "no fair value
  // gap needed", "ignore the daily bias" -- which `settle` works out from the
  // words around the phrase. See the note on negation there.
  {
    pattern: /\b(fair value gaps?|fvgs?|imbalances?)\b/,
    apply: (hit, reading) =>
      condition(
        hit,
        reading,
        'require_fair_value_gap',
        'Entry inside an unfilled gap',
        'Not required: an unfilled gap at the entry',
      ),
  },
  {
    pattern: /\b(smt(?:\s+divergences?)?|divergences?)\b/,
    apply: (hit, reading) =>
      condition(
        hit,
        reading,
        'require_smt_divergence',
        'A confirmed SMT divergence',
        'Not required: an SMT divergence',
      ),
  },
  {
    pattern: /\b(swing (?:point|high|low)s?|market structure|structure break)\b/,
    apply: (hit, reading) =>
      condition(
        hit,
        reading,
        'require_swing_point',
        'A confirmed swing point',
        'Not required: a swing point',
      ),
  },
  {
    /*
     * A sweep is an *event*, so this matches verbs rather than nouns.
     *
     * Matching a bare "equal highs" was wrong twice over: it fired on
     * "target the equal highs", which is the opposite setting, and it read
     * "I trade equal highs" as a rule about one particular entry. Requiring
     * the verb also picks up the passive voice the app's own preset summary
     * uses -- "enter after the lows are taken" -- which the old alternation
     * missed entirely.
     */
    pattern:
      /\b(?:liquidity\s+sweep|stop\s+hunt|sweeps?|swept|(?:takes?|took)\s+out|(?:are|were|is|was|been|get|gets|got)\s+(?:taken|swept|cleared))\b/,
    apply: (hit, reading) =>
      condition(
        hit,
        reading,
        'require_liquidity_sweep',
        'A liquidity pool had just been swept',
        'Not required: a liquidity sweep',
      ),
  },
  {
    /*
     * The higher-timeframe frame.
     *
     * Only the switch, never which timeframe: that is a workspace setting
     * with its own control, which a description does not reach. A named
     * timeframe used to vanish -- "with the daily bias" switched the
     * condition on, left the form reading whatever it was set to, and the
     * account gave no hint -- so it is now quoted as unread, and the account
     * says whose timeframe the run will use. The phrase has to name the
     * *timeframe* rather than merely a direction, or "bullish setup" would
     * turn on a condition nobody asked for.
     */
    pattern: new RegExp(
      String.raw`\b(?:(?:higher|larger|bigger)\s+time\s?frame|htf|(${TIMEFRAME}))\s+(?:${BIAS})\b` +
        String.raw`|\b(?:with|in\s+line\s+with|aligned\s+with)\s+the\s+` +
        String.raw`(?:(?:higher\s+time\s?frame|htf|(${TIMEFRAME}))(?:\s+(?:${BIAS}))?|trend)\b`,
    ),
    apply: (hit, reading) => {
      const named = hit.match[1] ?? hit.match[2]
      const read = condition(
        hit,
        reading,
        'require_higher_timeframe_bias',
        named
          ? 'The higher timeframe set on the form agreed with the trade'
          : 'The higher timeframe agreed with the trade',
        'Not required: the higher timeframe agreeing',
      )
      if (read && hit.polarity === 'on' && named) cannotRead(reading, named)
      return read
    },
  },
  {
    /*
     * A reaction at the level. Verbs and shapes, not the word "wick" alone:
     * "the wick of the candle" is a description of where a level sits, not a
     * demand that the entry bar have one.
     */
    pattern:
      /\b(?:strong\s+(?:reaction|rejection)|reacts?|reacted|reject(?:s|ed|ion)?\s+(?:off|from|at)|(?:long|big|large)\s+(?:lower\s+|upper\s+)?wicks?|rejection\s+wicks?|wicks?\s+(?:off|through|below|above))\b/,
    apply: (hit, reading) =>
      condition(
        hit,
        reading,
        'require_reaction',
        'The bar at the level rejected and closed back through its open',
        'Not required: a rejection at the level',
      ),
  },
  {
    /*
     * The retracement entry. "OTE" is the name Miles uses for it, and the
     * band it refers to is the default, so naming it need not also set the
     * numbers -- doing that would overwrite a band the user had widened.
     */
    pattern:
      /\b(?:ote|optimal\s+trade\s+entry|fib(?:onacci)?\s*(?:retrace(?:ment)?|entry|level)?|retrace(?:ment|s|d)?\s+(?:into|to|back)|deep\s+retrace(?:ment)?)\b/,
    apply: (hit, reading) =>
      entry(
        hit,
        reading,
        'fib_retrace',
        'Only entries inside the retracement of the last swing leg',
        'Not required: an entry in the retracement',
      ),
  },
  {
    // Straight off the level: the other half of the pair, and the one that
    // has to be said out loud to stop the run taking both.
    pattern:
      /\b(?:immediate(?:ly)?\s+(?:reversal|entry|off)|straight\s+(?:off|from)|no\s+retrace(?:ment)?|without\s+(?:a\s+)?retrace(?:ment)?)\b/,
    apply: (hit, reading) =>
      entry(
        hit,
        reading,
        'immediate',
        'Only entries taken straight off the level',
        'Not required: an entry straight off the level',
      ),
  },
  {
    /*
     * Sessions. One rule, reading every session the clause names.
     *
     * A filter narrower than the one asked for is the direction of error
     * that silently removes trades, and it happened twice: "london or new
     * york am" once read as London alone, and "the London and New York
     * sessions" still did, because a bare "New York" named no session at
     * all. New York on its own is both of its killzones. A time that is not
     * a killzone -- "the London close", "NY lunch" -- is reported rather
     * than rounded to the nearest one, and a level named after a session --
     * "the Asian range", "the London high" -- is a level, not a demand that
     * the entry happen then.
     *
     * A session the text says to stay out of cannot be written into this
     * filter, which lists where entries may happen. It is satisfied when the
     * sessions asked for leave it out, and reported when none were: "not
     * Asia" turned into every killzone but Asia would also drop the hours
     * between them.
     */
    pattern: new RegExp(
      String.raw`\b(asian?|london|new\s+york|ny)\b` +
        String.raw`(?:\s+(am|pm)(?:\s*(?:and|or|&|\/)\s*(am|pm))?\b` +
        String.raw`|\s+(open|close|lunch|midnight|morning|afternoon|range|highs?|lows?|time)\b)?` +
        String.raw`(?:\s+(?:sessions?|killzones?|kill\s+zones?)\b)?`,
    ),
    applyAll: (hits, reading) => {
      const text = reading.clause.lower
      const asked: Hit[] = []
      const found: SessionKey[] = []
      for (const hit of hits) {
        const named = sessionsNamed(hit.match)
        if (named === null) continue
        // A time that is no killzone is unreadable whatever is said about it,
        // so it is quoted alone.
        if (named === 'unknown') {
          cannotRead(reading, hit.match[0])
          continue
        }
        if (hit.polarity === 'unclear') {
          cannotRead(reading, hit.quoted)
          continue
        }
        // "Outside" negates a time and nothing else, so it is read here
        // rather than in `settle`: "stop outside the gap" is not ruling the
        // gap out.
        const outside = /\boutside\s+(?:of\s+)?(?:the\s+)?$/.exec(text.slice(0, hit.start))
        const avoid = outside ? hit.polarity === 'on' : hit.polarity === 'off'
        if (avoid) {
          const quoted = outside ? text.slice(outside.index, hit.end) : hit.quoted
          reading.avoided.push({ sessions: named, clause: reading.clause, quoted })
          continue
        }
        asked.push(hit)
        found.push(...named)
      }
      if (asked.length === 0) return null
      reading.clause.read = true

      const current = reading.into.detectors.sessions ?? []
      // Canonical order, not the order they were typed, so the summary line
      // reads the same however the sentence was phrased.
      reading.into.detectors.sessions = SESSION_KEYS.filter(
        (key) => found.includes(key) || current.includes(key),
      )
      const added = SESSION_KEYS.filter((key) => found.includes(key) && !current.includes(key))
      if (added.length === 0) return null
      return {
        phrase: text.slice(asked[0].start, asked[asked.length - 1].end),
        setting: 'Session',
        value: `Only entries inside ${added.map((key) => SESSION_LABELS[key]).join(' or ')}`,
      }
    },
  },
  {
    // Consequent encroachment. It only narrows the gap condition, so it turns
    // that on as well -- "half the gap" with no gap required is not a rule.
    pattern:
      /\b(?:consequent\s+encroachment|mid(?:dle|point)?\s*(?:line)?\s+of\s+the\s+gap|gap\s+mid(?:dle|point|line)|50\s*%\s+of\s+the\s+gap)\b/,
    apply: (hit, reading) => {
      // Which is also why it cannot narrow a gap the text has ruled out.
      if (hit.polarity === 'on' && reading.stances.get('require_fair_value_gap') === false) {
        return cannotRead(reading, hit.quoted)
      }
      const read = condition(
        hit,
        reading,
        'gap_past_midpoint',
        'Entry past the midpoint of an unfilled gap',
        'Not required: an entry past the gap midpoint',
      )
      if (read && hit.polarity === 'on') {
        reading.stances.set('require_fair_value_gap', true)
        reading.into.detectors.require_fair_value_gap = true
      }
      return read
    },
  },
  {
    pattern: new RegExp(String.raw`\bwithin\s*${NUMBER}\s*bars?\b`),
    apply: ({ match }, { into }) => {
      const value = bounded(Math.round(Number(match[1])), 1, 500)
      into.detectors.within_bars = value
      return { phrase: match[0], setting: 'Condition age', value: `Within ${value} bars` }
    },
  },

  // ---- search -----------------------------------------------------------
  {
    pattern: new RegExp(String.raw`\b(?:top|best|up to|at most)\s*${NUMBER}\s*(?:matches|instances|examples)\b`),
    apply: ({ match }, { into }) => {
      const value = bounded(Math.round(Number(match[1])), 1, MAX_PATTERN_MATCHES)
      into.search.maximumMatches = value
      return { phrase: match[0], setting: 'Matches', value: `At most ${value}` }
    },
  },
  {
    pattern: new RegExp(String.raw`\bsimilarity\s*(?:of|above|over|at least)?\s*${NUMBER}`),
    apply: ({ match }, { into }) => {
      // Written either way round: "similarity 0.7" and "similarity 70".
      const raw = Number(match[1])
      const value = bounded(raw > 1 ? raw / 100 : raw, 0, 1)
      into.search.minimumSimilarity = value
      return { phrase: match[0], setting: 'Similarity', value: `At least ${value.toFixed(2)}` }
    },
  },
  {
    /*
     * How far back to search.
     *
     * It needs a word that says *search* -- "look back", "over the last",
     * "of history" -- because a span of days is just as often part of a
     * condition: "long after the past 2 days were bearish" set a two-day
     * lookback, a search over almost nothing, out of a sentence that never
     * mentioned the search. A clause that is nothing but the span ("last 90
     * days") is read as one too, since there is nothing else in it for the
     * span to describe.
     */
    pattern: new RegExp(
      String.raw`\b(?:look(?:ing)?[\s-]*back|lookback|search(?:ing)?)` +
        String.raw`(?:\s+(?:of|over|across|through|in))?(?:\s+the)?(?:\s+(?:last|past|previous))?\s*${SPAN}\b` +
        String.raw`|\b(?:over|across)\s+(?:the\s+)?(?:last|past|previous)\s*${SPAN}\b` +
        String.raw`|\b${SPAN}\s+(?:of\s+(?:history|data)|back)\b` +
        String.raw`|^(?:(?:on|for|from|in|over|across|using|use)\s+)?(?:the\s+)?(?:last|past|previous)\s*${SPAN}$`,
    ),
    apply: ({ match }, { into }) => {
      const [count, unit] = match.slice(1).filter((part) => part !== undefined)
      const days = unit.startsWith('week')
        ? Number(count) * 7
        : unit.startsWith('month')
          ? Number(count) * 30
          : unit.startsWith('year')
            ? Number(count) * 365
            : Number(count)
      into.search.lookbackDays = bounded(Math.round(days), 1, 730)
      return {
        phrase: match[0],
        setting: 'Lookback',
        value: `${into.search.lookbackDays} days`,
      }
    },
  },
]

/** Each rule's pattern made global, so a clause can be searched for every match. */
const PATTERNS = RULES.map((rule) => new RegExp(rule.pattern.source, `${rule.pattern.flags}g`))

/**
 * Negation.
 *
 * "No fair value gap needed" used to switch the gap condition *on*: the
 * grammar matched the noun and never looked at the word in front of it, so
 * the plainest way of saying "I don't want this" asked for it, and the run
 * came back holding only the trades the user had just said did not matter.
 *
 * What counts is the few words before a phrase, back to the first word that
 * starts something new, and "not needed" and its kin straight after it. Two
 * negations cancel -- "never enter without a gap" asks for the gap -- and a
 * negation outside an "after" or an "until" is reported rather than guessed
 * at, because there the same words mean either thing.
 */
const NEGATORS = new Set([
  'no', 'not', 'never', 'without', 'neither', 'nor', 'cannot', 'optional', 'optionally',
  'ignore', 'ignores', 'ignored', 'ignoring', 'skip', 'skips', 'skipped', 'skipping',
  'exclude', 'excludes', 'excluded', 'excluding', 'avoid', 'avoids', 'avoided', 'avoiding',
  'regardless', 'irrespective', 'dont', 'doesnt', 'didnt', 'isnt', 'arent', 'wasnt',
  'werent', 'cant', 'wont', 'neednt', 'shouldnt', 'mustnt',
])
/** Words after which the words before them no longer reach the phrase. */
const ENDS_NEGATION = new Set([
  'but', 'and', 'then', 'only', 'with', 'plus', 'also', 'yet', 'so', 'though', 'although',
  'however', 'while', 'whereas', 'instead', 'rather',
])
/** Words that open a clause of their own inside the sentence. */
const OPENS_CLAUSE = new Set(['until', 'till', 'before', 'after', 'once', 'when', 'whenever', 'if'])
/** Words that turn what follows them round, to an effect set by what came first. */
const TURNS_CLAUSE = new Set(['unless', 'except'])
/**
 * What may stand between "no" and the phrase it rules out.
 *
 * "No" negates the noun after it, and only that one: in "no news days inside
 * a gap" it is the news that is ruled out, while "no entries inside a gap"
 * means avoiding gaps, which this cannot set. With anything else in between,
 * the phrase is reported rather than read either way.
 */
const NO_REACHES = new Set(['need', 'needs', 'requirement', 'requirements', 'use', 'for', 'of', 'or'])
const ARTICLES = new Set(['a', 'an', 'the', 'any'])
/** How many words back a negation reaches, not counting articles. */
const NEGATION_REACH = 5
const WORDS = /[a-z0-9]+(?:['’][a-z]+)?|[:()[\]–—]|\s-\s/g
const NOT_NEEDED = new RegExp(
  String.raw`^[\s:–—-]*(?:(?:is|are|was|were)\s+)?` +
    String.raw`(?:(?:not|(?:isn|aren|wasn|weren)['’]?t)\s+` +
    String.raw`(?:needed|required|necessary|important|a\s+(?:requirement|must))` +
    String.raw`|(?:does\s+not|doesn['’]?t|do\s+not|don['’]?t)\s+matter` +
    String.raw`|(?:can\s+be\s+)?(?:ignored|skipped)|optional|unnecessary|irrelevant)\b`,
)

function isNegator(token: string): boolean {
  return NEGATORS.has(token) || token.endsWith("n't")
}

/**
 * Work out what the words around a hit do to it.
 *
 * Phrases another rule has read are passed over rather than stopped at. In
 * "long without a gap" the direction sits in front of the negation and
 * changes nothing; in "no retrace into a gap" the "no" belongs to the
 * retrace, and since it lies inside that rule's phrase it is not counted
 * against the gap.
 */
function settle(hit: Hit, text: string, others: Hit[]): void {
  const taken = (at: number) =>
    others.some((other) => other !== hit && other.spans.some(([a, b]) => at >= a && at < b))
  let negations = 0
  let from = hit.start
  let opened = false
  let unclear = false
  const between: string[] = []
  for (const word of [...text.slice(0, hit.start).matchAll(WORDS)].reverse()) {
    const at = word.index ?? 0
    if (taken(at)) continue
    const token = word[0].trim().replace(/’/g, "'")
    if (ARTICLES.has(token)) continue
    if (between.length >= NEGATION_REACH || !/[a-z0-9]/.test(token)) break
    // Unless a nearer negation is what it negates: "no trades without a gap".
    const elsewhere =
      token === 'no' && negations === 0 && between.some((other) => !NO_REACHES.has(other))
    if (TURNS_CLAUSE.has(token) || (opened && isNegator(token)) || elsewhere) {
      unclear = true
      from = at
      break
    }
    between.push(token)
    if (isNegator(token)) {
      negations += 1
      from = at
      // "Neither A nor B": the "nor" is B's negation and the "neither" is A's.
      if (token === 'nor') break
    } else if (ENDS_NEGATION.has(token)) {
      break
    } else if (OPENS_CLAUSE.has(token)) {
      opened = true
    }
  }
  const after = NOT_NEEDED.exec(text.slice(hit.end))
  if (after) negations += 1
  hit.polarity = unclear ? 'unclear' : negations % 2 === 1 ? 'off' : 'on'
  hit.quoted = text.slice(from, hit.end + (after?.[0].length ?? 0)).trim()
}

function overlaps(a: Span[], b: Span[]): boolean {
  return a.some(([start, end]) => b.some(([other, otherEnd]) => start < otherEnd && other < end))
}

/**
 * Every place a rule matches in a clause, each stretch of text going to one
 * rule, grouped in the order the rules are listed.
 *
 * "Stop below the swing low" set a stop at the pattern extreme *and* a
 * swing-point entry condition: the stop rule read the whole phrase, then the
 * swing rule found "swing low" inside it and read that again. A phrase is
 * one instruction, so the text a rule reads is now taken. Where two matches
 * overlap the one that starts first keeps it, the longer one on a tie --
 * the rule the phrase was written for, since its first word is where the
 * phrase begins.
 */
function hitsIn(text: string): Hit[][] {
  const found: { rule: number; hit: Hit }[] = []
  RULES.forEach((rule, index) => {
    for (const match of text.matchAll(PATTERNS[index])) {
      const start = match.index ?? 0
      const owned: Span[] = rule.owns?.(match) ?? [[0, match[0].length]]
      found.push({
        rule: index,
        hit: {
          match,
          start,
          end: start + match[0].length,
          spans: owned.map(([a, b]): Span => [start + a, start + b]),
          polarity: 'on',
          quoted: match[0],
        },
      })
    }
  })
  found.sort((a, b) => a.hit.start - b.hit.start || b.hit.end - a.hit.end || a.rule - b.rule)

  const kept: typeof found = []
  for (const item of found) {
    if (!kept.some(({ hit }) => overlaps(hit.spans, item.hit.spans))) kept.push(item)
  }
  const hits = kept.map(({ hit }) => hit)
  for (const hit of hits) settle(hit, text, hits)
  return RULES.map((_, index) =>
    kept.filter((item) => item.rule === index).map((item) => item.hit),
  )
}

/**
 * Split on sentence ends and on the commas traders use as clause breaks.
 *
 * A full stop only ends a sentence when a digit does not follow it.
 * Splitting on every period cut "stop at 0.5%" into "stop at 0" and "5%",
 * and the damage was quiet in the worst way: neither half matched any rule,
 * so the stop was dropped *and* reported as text the grammar could not
 * read. Every failing case was a decimal, which is what gave it away.
 */
function clausesOf(text: string): string[] {
  return text
    .split(/[;\n]+|\.(?!\d)|,(?=\s)/)
    .map((clause) => clause.trim())
    .filter(Boolean)
}

/**
 * Give a decimal written without its leading zero the zero back.
 *
 * ".5% stop" read as a 5% stop and ".5R" as a 5R target -- ten times what
 * was written -- because the numeric patterns start at a word boundary, and
 * the one they found was between the dot and the 5. Writing the zero in
 * before any rule looks means every numeric rule reads the number the trader
 * wrote, rather than each one having to be taught about the dot.
 */
function withLeadingZeros(text: string): string {
  return text.replace(/(^|[^\d.])\.(\d)/g, (_, before: string, digit: string) => `${before}0.${digit}`)
}

/**
 * Markets named in the text.
 *
 * Separate from the grammar because a symbol can appear anywhere in any
 * clause and is never the *only* thing a clause says -- "long NQ into a gap"
 * names a market, a direction and a condition at once.
 */
function symbolsIn(text: string): SymbolKey[] {
  const upper = text.toUpperCase()
  return SYMBOLS.filter((symbol) => new RegExp(String.raw`\b${symbol}\b`).test(upper))
}

/**
 * Decide the direction once every clause has been read.
 *
 * Trade verbs decide it if there are any, and the market's adjectives only
 * when there are none. Verbs that disagree decide nothing and are quoted
 * back. A ruled-out direction ("no shorts") is read when what was decided
 * leaves it out, and quoted when nothing was decided, since the form cannot
 * hold "anything but short" except as "long", which is a guess.
 */
function settleDirection({ into, directions }: Omit<Reading, 'clause'>): void {
  const asked = directions.filter((word) => !word.negated)
  const verbs = asked.filter((word) => word.verb)
  const deciding = verbs.length > 0 ? verbs : asked
  const named = new Set(deciding.map((word) => word.direction))
  if (named.size === 1) {
    const [direction] = named
    into.rules.direction = direction
    into.understood.splice(deciding[0].at, 0, {
      phrase: deciding[0].phrase,
      setting: 'Direction',
      value: direction === 'long' ? 'Long' : 'Short',
    })
    for (const word of deciding) word.clause.read = true
  } else {
    for (const word of deciding) word.clause.unread.push(word.phrase)
  }
  for (const word of directions.filter((item) => item.negated)) {
    const satisfied = into.rules.direction !== undefined && into.rules.direction !== word.direction
    if (satisfied) word.clause.read = true
    else word.clause.unread.push(word.quoted)
  }
}

/** Check the sessions the text said to stay out of against the filter it built. */
function settleAvoided({ into, avoided }: Omit<Reading, 'clause'>): void {
  const sessions = into.detectors.sessions ?? []
  for (const { sessions: named, clause, quoted } of avoided) {
    if (sessions.length > 0 && named.every((key) => !sessions.includes(key))) clause.read = true
    else clause.unread.push(quoted)
  }
}

/**
 * Read a description into a strategy patch.
 *
 * Case-insensitive throughout, and applied clause by clause so that the
 * account of what was understood can quote the words responsible. The
 * direction and the sessions to avoid are settled last, because whether one
 * word can be applied depends on what the rest of the text said.
 */
export function interpret(text: string): Interpretation {
  const into: Interpretation = {
    rules: {},
    search: {},
    detectors: {},
    understood: [],
    unread: [],
  }

  const symbols = symbolsIn(text)
  if (symbols.length > 0) {
    into.search.searchSymbols = symbols
    into.understood.push({
      phrase: symbols.join(', '),
      setting: 'Markets',
      value: symbols.join(' and '),
    })
  }

  const clauses: Clause[] = clausesOf(text).map((clause) => ({
    text: clause,
    lower: withLeadingZeros(clause.toLowerCase()),
    read: false,
    unread: [],
  }))
  const shared: Omit<Reading, 'clause'> = {
    into,
    stances: new Map(),
    directions: [],
    avoided: [],
  }

  for (const clause of clauses) {
    const reading: Reading = { ...shared, clause }
    hitsIn(clause.lower).forEach((hits, index) => {
      if (hits.length === 0) return
      const rule = RULES[index]
      const understood = rule.applyAll
        ? rule.applyAll(hits, reading)
        : (rule.apply?.(hits[0], reading) ?? null)
      if (understood) {
        into.understood.push(understood)
        clause.read = true
      }
    })
  }

  settleDirection(shared)
  settleAvoided(shared)

  for (const clause of clauses) {
    into.unread.push(...clause.unread)
    // A clause that only named a market has still been read.
    if (!clause.read && clause.unread.length === 0 && symbolsIn(clause.text).length === 0) {
      into.unread.push(clause.text)
    }
  }

  return into
}

/**
 * The whole strategy an interpretation describes, filled out from defaults.
 *
 * Same rule as the presets: a description replaces the strategy rather than
 * editing it, so what is on the form is what the sentence says and nothing
 * left over from before it.
 */
export function strategyFrom(interpretation: Interpretation): {
  rules: TradeRules
  detectors: DetectorFilters
  search: SearchConfig
} {
  return {
    rules: { ...DEFAULT_TRADE_RULES, ...interpretation.rules },
    detectors: { ...DEFAULT_DETECTOR_FILTERS, ...interpretation.detectors },
    search: { ...DEFAULT_SEARCH_CONFIG, ...interpretation.search },
  }
}
