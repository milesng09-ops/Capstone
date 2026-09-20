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
  DEFAULT_TRADE_RULES,
  type DetectorFilters,
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
   * Sentences with no recognised instruction in them.
   *
   * Reported rather than dropped: a description that mentions a condition
   * this grammar has never heard of produces a strategy that is missing it,
   * and the user has to be able to see that rather than discover it in a
   * result.
   */
  unread: string[]
}

interface Rule {
  /** What to look for. Must have at least one capture group when numeric. */
  pattern: RegExp
  apply: (match: RegExpMatchArray, into: Interpretation) => Understood | null
}

const NUMBER = String.raw`(\d+(?:\.\d+)?)`

/**
 * Which words name which killzone.
 *
 * Longest first: "new york am" has to be tried before a bare "new york",
 * or the afternoon session would be unreachable by name.
 */
const SESSION_PHRASES: [RegExp, SessionKey][] = [
  [/new\s+york\s+pm|ny\s+pm/, 'new_york_pm'],
  [/new\s+york\s+am|ny\s+am|new\s+york\s+open|ny\s+open/, 'new_york_am'],
  [/london/, 'london'],
  [/asia/, 'asia'],
]

/**
 * The grammar, in the order it is applied.
 *
 * Order matters in one place and is deliberate there: the reward-to-risk
 * forms are tried before the plain percentage target, so "2R" is not read as
 * a number with a stray letter after it.
 */
const RULES: Rule[] = [
  // ---- direction --------------------------------------------------------
  {
    pattern: /\b(short|sell|bearish|downside)\b/,
    apply: (match, into) => {
      into.rules.direction = 'short'
      return { phrase: match[0], setting: 'Direction', value: 'Short' }
    },
  },
  {
    pattern: /\b(long|buy|bullish|upside)\b/,
    apply: (match, into) => {
      into.rules.direction = 'long'
      return { phrase: match[0], setting: 'Direction', value: 'Long' }
    },
  },

  // ---- entry ------------------------------------------------------------
  {
    pattern: /\b(next open|next bar|following open|open of the next)\b/,
    apply: (match, into) => {
      into.rules.entry_type = 'next_open'
      return { phrase: match[0], setting: 'Entry', value: "Next bar's open" }
    },
  },

  // ---- stop -------------------------------------------------------------
  {
    pattern: new RegExp(String.raw`\b${NUMBER}\s*(?:x\s*)?atr\b[^.]{0,20}?stop|stop[^.]{0,20}?\b${NUMBER}\s*(?:x\s*)?atr\b`),
    apply: (match, into) => {
      const value = Number(match[1] ?? match[2])
      into.rules.stop_loss_type = 'atr_multiple'
      into.rules.stop_loss_value = value
      return { phrase: match[0], setting: 'Stop loss', value: `${value} x ATR` }
    },
  },
  {
    pattern: /\bstop[^.]{0,24}?\b(pattern (?:low|high|extreme)|swing (?:low|high)|structure)\b/,
    apply: (match, into) => {
      into.rules.stop_loss_type = 'pattern_extreme'
      into.rules.stop_loss_value = 0
      return { phrase: match[0], setting: 'Stop loss', value: 'Beyond the pattern extreme' }
    },
  },
  {
    pattern: new RegExp(String.raw`\b${NUMBER}\s*%\s*stop\b|\bstop\s*(?:of|at|loss)?\s*${NUMBER}\s*%`),
    apply: (match, into) => {
      const value = Number(match[1] ?? match[2])
      into.rules.stop_loss_type = 'percentage'
      into.rules.stop_loss_value = value
      return { phrase: match[0], setting: 'Stop loss', value: `${value}% from entry` }
    },
  },

  // ---- target -----------------------------------------------------------
  {
    pattern: new RegExp(String.raw`\b${NUMBER}\s*r\b|\brisk[- ]?reward\s*(?:of)?\s*${NUMBER}|\b${NUMBER}\s*:\s*1\b`),
    apply: (match, into) => {
      const value = Number(match[1] ?? match[2] ?? match[3])
      /*
       * A number of R does not overrule an exit that has already been named.
       *
       * "Target the next shelf of highs, minimum 1.5R" is one instruction,
       * not two competing ones: with a liquidity target, `take_profit_value`
       * *is* the minimum reward. Overwriting the type here produced a plain
       * 1.5R target while the account of what was understood claimed both --
       * the exact failure this module exists to prevent, and it fired on the
       * most natural sentence for the liquidity preset.
       *
       * Rules are applied clause by clause, so neither ordering is the
       * canonical one and this cannot be fixed by moving rules around.
       */
      const floor = into.rules.take_profit_type === 'liquidity'
      if (!floor) into.rules.take_profit_type = 'risk_reward'
      into.rules.take_profit_value = value
      return {
        phrase: match[0],
        setting: floor ? 'Minimum reward' : 'Target',
        value: floor ? `At least ${value}x the risk` : `${value}x the risk`,
      }
    },
  },
  {
    pattern: new RegExp(String.raw`\b(?:target|take profit|tp)\s*(?:of|at)?\s*${NUMBER}\s*%`),
    apply: (match, into) => {
      const value = Number(match[1])
      into.rules.take_profit_type = 'percentage'
      into.rules.take_profit_value = value
      return { phrase: match[0], setting: 'Target', value: `${value}% from entry` }
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
    apply: (match, into) => {
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
    apply: (match, into) => {
      const value = Math.round(Number(match[1] ?? match[2]))
      into.rules.maximum_holding_bars = value
      return { phrase: match[0], setting: 'Maximum hold', value: `${value} bars` }
    },
  },

  // ---- conditions -------------------------------------------------------
  {
    pattern: /\b(fair value gaps?|fvgs?|imbalances?)\b/,
    apply: (match, into) => {
      into.detectors.require_fair_value_gap = true
      return { phrase: match[0], setting: 'Condition', value: 'Entry inside an unfilled gap' }
    },
  },
  {
    pattern: /\b(smt|divergences?)\b/,
    apply: (match, into) => {
      into.detectors.require_smt_divergence = true
      return { phrase: match[0], setting: 'Condition', value: 'A confirmed SMT divergence' }
    },
  },
  {
    pattern: /\b(swing (?:point|high|low)s?|market structure|structure break)\b/,
    apply: (match, into) => {
      into.detectors.require_swing_point = true
      return { phrase: match[0], setting: 'Condition', value: 'A confirmed swing point' }
    },
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
    apply: (match, into) => {
      into.detectors.require_liquidity_sweep = true
      return {
        phrase: match[0],
        setting: 'Condition',
        value: 'A liquidity pool had just been swept',
      }
    },
  },
  {
    /*
     * The higher-timeframe frame.
     *
     * Only the switch, never which timeframe: that is a workspace setting
     * with its own control, and a description that said "4h" would be
     * silently ignored if this pretended to read it. The phrase has to name
     * the *timeframe* rather than merely a direction, or "bullish setup"
     * would turn on a condition nobody asked for.
     */
    pattern:
      /\b(?:(?:higher|larger|bigger)\s+time\s?frame|htf|daily|weekly|4\s?h(?:our)?)\s+(?:bias|trend|direction|structure)\b|\b(?:with|in\s+line\s+with|aligned\s+with)\s+the\s+(?:higher\s+time\s?frame|htf|daily|weekly|trend)\b/,
    apply: (match, into) => {
      into.detectors.require_higher_timeframe_bias = true
      return {
        phrase: match[0],
        setting: 'Condition',
        value: 'The higher timeframe agreed with the trade',
      }
    },
  },
  {
    /*
     * A reaction at the level. Verbs and shapes, not the word "wick" alone:
     * "the wick of the candle" is a description of where a level sits, not a
     * demand that the entry bar have one.
     */
    pattern:
      /\b(?:strong\s+(?:reaction|rejection)|reacts?|reacted|reject(?:s|ed|ion)?\s+(?:off|from|at)|(?:long|big|large)\s+(?:lower\s+|upper\s+)?wick|rejection\s+wick|wicks?\s+(?:off|through|below|above))\b/,
    apply: (match, into) => {
      into.detectors.require_reaction = true
      return {
        phrase: match[0],
        setting: 'Condition',
        value: 'The bar at the level rejected and closed back through its open',
      }
    },
  },
  {
    /*
     * The retracement entry. "OTE" is the name Miles uses for it, and the
     * band it refers to is the default, so naming it need not also set the
     * numbers -- doing that would overwrite a band the user had widened.
     */
    pattern:
      /\b(?:ote|optimal\s+trade\s+entry|fib(?:onacci)?\s*(?:retrace(?:ment)?|entry|level)?|retrace(?:ment|s|d)?\s+(?:into|to|back)|deep\s+retrace(?:ment)?)\b/,
    apply: (match, into) => {
      into.detectors.entry_model = 'fib_retrace'
      return {
        phrase: match[0],
        setting: 'Entry',
        value: 'Only entries inside the retracement of the last swing leg',
      }
    },
  },
  {
    // Straight off the level: the other half of the pair, and the one that
    // has to be said out loud to stop the run taking both.
    pattern:
      /\b(?:immediate(?:ly)?\s+(?:reversal|entry|off)|straight\s+(?:off|from)|no\s+retrace(?:ment)?|without\s+(?:a\s+)?retrace(?:ment)?)\b/,
    apply: (match, into) => {
      into.detectors.entry_model = 'immediate'
      return {
        phrase: match[0],
        setting: 'Entry',
        value: 'Only entries taken straight off the level',
      }
    },
  },
  {
    /*
     * Sessions. One rule, but it reads the *whole clause* rather than the
     * one phrase that tripped it.
     *
     * The loop applies each rule once per clause, so a rule that took only
     * its own match would read "london or new york am" as London and drop
     * the rest -- a filter narrower than the one that was asked for, which
     * is the direction of error that silently removes trades.
     */
    pattern:
      /\b(?:asia(?:n)?|london|new\s+york|ny)\b(?:\s+(?:am|pm|open|session|killzone|kill\s+zone))?/,
    apply: (match, into) => {
      const found = SESSION_PHRASES.filter(([pattern]) =>
        pattern.test(match.input ?? match[0]),
      ).map(([, key]) => key)
      if (found.length === 0) return null

      const current = into.detectors.sessions ?? []
      // Canonical order, not the order they were typed, so the summary line
      // reads the same however the sentence was phrased.
      into.detectors.sessions = SESSION_KEYS.filter(
        (item) => found.includes(item) || current.includes(item),
      )
      const added = found.filter((key) => !current.includes(key))
      if (added.length === 0) return null
      return {
        phrase: match[0],
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
    apply: (match, into) => {
      into.detectors.require_fair_value_gap = true
      into.detectors.gap_past_midpoint = true
      return {
        phrase: match[0],
        setting: 'Condition',
        value: 'Entry past the midpoint of an unfilled gap',
      }
    },
  },
  {
    pattern: new RegExp(String.raw`\bwithin\s*${NUMBER}\s*bars?\b`),
    apply: (match, into) => {
      const value = Math.round(Number(match[1]))
      into.detectors.within_bars = value
      return { phrase: match[0], setting: 'Condition age', value: `Within ${value} bars` }
    },
  },

  // ---- search -----------------------------------------------------------
  {
    pattern: new RegExp(String.raw`\b(?:top|best|up to|at most)\s*${NUMBER}\s*(?:matches|instances|examples)\b`),
    apply: (match, into) => {
      const value = Math.round(Number(match[1]))
      into.search.maximumMatches = value
      return { phrase: match[0], setting: 'Matches', value: `At most ${value}` }
    },
  },
  {
    pattern: new RegExp(String.raw`\bsimilarity\s*(?:of|above|over|at least)?\s*${NUMBER}`),
    apply: (match, into) => {
      // Written either way round: "similarity 0.7" and "similarity 70".
      const raw = Number(match[1])
      const value = raw > 1 ? raw / 100 : raw
      into.search.minimumSimilarity = value
      return { phrase: match[0], setting: 'Similarity', value: `At least ${value.toFixed(2)}` }
    },
  },
  {
    pattern: new RegExp(String.raw`\b(?:last|past|over|previous)\s*${NUMBER}\s*(days?|weeks?|months?|years?)\b`),
    apply: (match, into) => {
      const count = Number(match[1])
      const unit = match[2]
      const days = unit.startsWith('week')
        ? count * 7
        : unit.startsWith('month')
          ? count * 30
          : unit.startsWith('year')
            ? count * 365
            : count
      into.search.lookbackDays = Math.round(days)
      return {
        phrase: match[0],
        setting: 'Lookback',
        value: `${Math.round(days)} days`,
      }
    },
  },
]

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
 * Read a description into a strategy patch.
 *
 * Case-insensitive throughout, and applied clause by clause so that the
 * account of what was understood can quote the words responsible.
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

  for (const clause of clausesOf(text)) {
    const lower = clause.toLowerCase()
    let matchedHere = false

    for (const rule of RULES) {
      const match = lower.match(rule.pattern)
      if (!match) continue
      const understood = rule.apply(match, into)
      if (understood) {
        into.understood.push(understood)
        matchedHere = true
      }
    }

    // A clause that only named a market has still been read.
    if (!matchedHere && symbolsIn(clause).length === 0) into.unread.push(clause)
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
} {
  return {
    rules: { ...DEFAULT_TRADE_RULES, ...interpretation.rules },
    detectors: { ...DEFAULT_DETECTOR_FILTERS, ...interpretation.detectors },
  }
}
