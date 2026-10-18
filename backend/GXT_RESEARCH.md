# GXT research v1

Select **Backtest model → GXT research (experimental)** in the strategy panel.
Use a 1m, 2m, 3m, 5m, 15m, 30m or 1h chart; enable ES/NQ/YM comparison
charts when requiring cross-asset confirmation. Draw a test window, or choose
a lookback, and click **Backtest GXT research**. No example selection is needed.
Trades appear as labelled position boxes. Click one for saved sequence evidence,
the confirmation gap, entry, stop and target. Results → Notes explains data
coverage and rejection counts; Matches explains signals skipped at entry.

## What this implements

This is an explicit, provisional research hypothesis. It is **not** a trained
neural network, an implementation of all of Garrett's models, or a claim of
accurate GXT recognition. It bypasses pattern similarity and scans chronologically.

The broad context comes from the [official Anomaly site](https://tradeanomaly.com/),
which describes a liquidity sweep followed by reversal confirmation, and waiting
for lower-timeframe confirmation after higher-timeframe C2. That does **not**
specify the thresholds and execution choices below. Those are our research
choices, pending review against the user's chosen Garrett lessons.

### Executable rules

1. Build 4H candles from the chosen chart timeframe. The app's existing exchange
   session grid starts at 17:00 Chicago / 18:00 New York, tracking DST. Require
   every expected constituent candle and the full 4H interval to have elapsed.
   Shortened sessions and partial buckets are intentionally excluded.
2. Compare adjacent complete 4H candles, C1 then C2. Long: C2 takes C1's low,
   does not take its high, closes strictly inside C1, and closes above its own
   open. Short: mirror this. Reject both-sided sweeps, dojis and equality at
   the reclaimed range boundary. This is a sweep/reclaim profile, not the
   complete GXT Candle Profiles or Power of 3 taxonomy.
3. With cross-asset filtering enabled (default), all enabled comparison markets
   need complete candles at the exact C1/C2 timestamps. At least one must not
   take its corresponding prior extreme. No interpolation or forward filling.
   Opposite candle body directions are saved as observations only. Neither this
   divergence nor those bodies are labelled a verified PSP or Strength Switch.
4. After C2 closes, examine up to 12 chart candles (configurable). All three
   confirmation candles must form after that close. Long: candle 3 low > candle
   1 high, middle candle bullish with body/range >= 0.5 (configurable). Short:
   mirror. This is a displacement-gap confirmation; it does not wait for a
   later gap retest. It is an explicit hypothesis, not a verified definition
   of the Universal Sequence.
5. Cancel if the prospective stop or target trades before confirmation, or a
   constituent candle is missing. Expire before the next 4H close. Optionally
   accept entries only from 09:30 inclusive to 11:00 exclusive, New York time.
6. Enter at the immediately following bar's open, with adverse slippage.
   Stop: C2 extreme plus one outward instrument tick (configurable). Target:
   opposite C1 extreme. Require reward/risk >= 1.5 (configurable) at the slipped
   entry, before fees. Skip gap opens past either level. One attempt per C2;
   no searching for a better entry after a skipped signal.
7. Use the existing simulator's fees, slippage, stop-first intrabar ambiguity
   and maximum holding period. If overlap is off, another trade cannot enter
   on a bar during which the prior position exits. Stop simulation at missing
   history (including session breaks), reporting `end_of_data`; never assume
   the unknown interval was safe. A full session calendar could relax this
   conservatively restrictive behavior later.

Only the primary symbol trades; comparison markets supply context. Scan up to
the user's requested end, clamped to now, and discard still-forming candles.
Fetch three calendar days of warmup; warmup cannot generate entries before the
test start. Test the earliest N signals, currently at most 25 (the existing app
cap), including skipped signals. This is a capped sample, not an exhaustive
test of the period. Diagnostics disclose signals beyond the limit.

## Results and storage

`POST /api/backtests` accepts `strategy: "gxt_research"` and optional `gxt`
settings. Existing requests default to `strategy: "pattern"`.
The exact API route prefix can also be inspected in `/docs`.
The response and saved run contain:

- `configuration.strategy`, `configuration.gxt`, and execution cost settings;
- `summary.gxt.version = "gxt-research-v1"`;
- `summary.gxt.status = "experimental_unverified"` and `trained = false`;
- `summary.gxt.evidence[pattern_match_id]`: profile and confirmation timestamps,
  gap and price levels, comparison symbols and sequence explanations;
- `summary.gxt.skipped` and `summary.gxt.diagnostics`.

These live in the existing JSON columns, so no database migration or deletion
of prior runs is required. Similarity fields remain zero for wire compatibility;
GXT UI labels them as rules rather than presenting a false confidence score.
Saved evidence is used directly instead of recomputing generic ICT detections.
No GXT random-entry baseline or recognition accuracy has been measured.

## What is needed to train a model and claim GXT fidelity

1. Obtain exact definitions and lesson references for the requested Universal
   Sequence variants, profiles, PSP, Strength Switch, entries and invalidations.
2. Have a knowledgeable reviewer mark positive, negative and ambiguous examples
   on synchronized real ES/NQ/YM data. Save the source, as-of cutoff, rule
   version, reviewer and label. Research-generated candidates are not truth.
3. Build input windows ending at that cutoff. A completed-trade screenshot or
   future outcome must never appear among predictor inputs.
4. Train TS2Vec or another encoder/classifier as a separate experiment. Split
   by time and trade/thread, purge overlapping windows, fit preprocessing on
   training only, and reserve later periods for final evaluation.
5. Measure per-concept precision/recall, missed setups, false signals and
   calibration against reviewed labels. Compare with this explicit rule
   baseline. Report trading results separately, after costs.
6. Integrate a versioned trained checkpoint only after its input contract and
   evaluation are recorded. Until then the app must not present pattern-weight
   fitting or this research scanner as a trained GXT neural network.

Current limitations include missing full PSP/Strength Switch/asset ranking,
advanced sequence variants, tick-level execution, contract sizing and roll
normalization. Synthetic demo backtests cannot validate trading performance.

## Validation

`cd backend && .venv/bin/python -m pytest tests/test_gxt.py -q`

Tests cover mirrored long/short signals, prefix stability and future mutation,
closed 4H data, DST, missing synchronized candles, pre-entry invalidation,
next-open reward/risk, conservative stop/target ambiguity, missing-data exits,
source mixing, prevention of misleading weight training, and save/reload.
