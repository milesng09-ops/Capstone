# GXT research models

## Source-linked C2 continuation (v2)

The default UI variant is **4H continuation / 1H C2 (lesson subset)**. The API
continues to interpret requests without `gxt.sequence_model` as legacy v1, so
saved configurations do not silently change meaning. Select `legacy_gap` to
reproduce the old scanner.

Original sources, public English captions retrieved and author metadata
verified against YouTube on November 13, 2026:

- [4H PO3 Made Mechanical, 1:26–3:00](https://www.youtube.com/watch?v=BueHY7EFUx0&t=86):
  a new 4H candle opens into the third lower-timeframe candle after an already
  confirmed reversal inside the prior 4H candle.
- [4H Profiling, 0:32–1:01](https://www.youtube.com/watch?v=ayW4VPUw2yk&t=32):
  the C2 sweep/reclaim swing confirmation used by this subset.
- [Universal Sequence, 12:32 onward](https://www.youtube.com/watch?v=oucPinjDdlk&t=752):
  the broader continuation framework also requires gap selection, equilibrium
  and alignment. Those discretionary components are **not** fully captured by v2.

Executable v2 subset:

1. Build complete 1H and 4H candles from closed execution candles. The existing
   18:00 New York 4H grid is retained. No missing-candle interpolation.
2. The last two 1H candles before a new 4H open are C1 and C2. Long: C2 takes
   C1's low and closes above that low; short mirrors. Reject both-side sweeps
   as an explicit ambiguity filter. A same-direction candle body is not required.
3. Optionally require exact-time 1H sweep divergence on the comparison group.
   This is an additional research filter, not a claim of verified PSP.
4. Enter the next 4H open, also the start of 1H C3. A future FVG is not required.
   Stop beyond 1H C2, target the prior 4H extreme, apply configured reward/risk,
   fees, slippage, overlap, missing-history and holding rules. These exact
   execution choices are our research interpretation and need expert review.
5. Save source timestamps, confirmation time, rule version and execution
   evidence with every signal. Data after confirmation cannot change that signal.

`gxt.entry_interval` optionally selects execution candles independently of the
displayed chart. Null preserves chart-based behavior. 4H context and 1H swing
confirmation remain fixed in v2; the entry interval controls actual fills and
holding-bar duration. Changing it is a strategy change, not a cosmetic view.

The incident run `fbe1e93d-1f7f-4aa6-9186-3c789c206f4a` used legacy v1 on 1H:
2,986 NQ candles, 40 long profiles, 33 cross-asset rejections, seven remaining
profiles and no confirmed gap entries. It completed a scan; it did not estimate
recognition accuracy. Empty-run win rate now displays N/A.

Validation run `b877c777-9679-4938-9861-d5af0af6db9d` kept that original window,
long-only direction, cross-asset requirement, costs and holding settings, and
changed only to `c2_continuation`. Through the real API and Massive feed it
confirmed 17 candidates, executed 11 trades and skipped six for entry reward/risk.
The result was 36.3636% wins and -0.2455% simulated compounded net return.
This is a small development comparison, not an independent holdout or proof of
model fidelity or profitability. The strategy was developed after inspecting
the zero-trade run and must be evaluated on separate periods.

## Local lesson library and further learning

`research/gxt_lessons.json` records source IDs, rule timestamps, interpretations
and unresolved model components. Captions and the local index are stored under
gitignored `data/research/gxtradez/youtube`. Caption text is teaching material;
it is never automatically promoted into a labeled market setup or training truth.

From `backend`:

```bash
.venv/bin/pip install -r requirements-research.txt
.venv/bin/python -m scripts.collect_gxt_youtube collect
.venv/bin/python -m scripts.collect_gxt_youtube search --query "continuation candle three"
```

Collection fetches public captions and author metadata only. It stops with a
clear error on unavailable captions or unexpected authors and preserves old
captures. The initial three lessons produced 182 timestamped text chunks.
This is a source library, not a trained neural network. The required next
training inputs are reviewed positive/negative chart examples for each concept,
with pre-entry data cutoffs, followed by chronological holdout evaluation.

The supplied playlist `PLYfFh6w3dnU0` resolves to ten third-party course
reuploads. Its metadata was inspected; it was not treated as verified first-party
instruction. This implementation uses Garrett's own public uploads above.

## Legacy v1

Select **Backtest model → GXT research (experimental)** in the strategy panel.
Use a 1m, 2m, 3m, 5m, 15m, 30m or 1h chart; enable ES/NQ/YM comparison
charts when requiring cross-asset confirmation. Draw a test window, or choose
a lookback, and click **Backtest GXT research**. No example selection is needed.
Trades appear as labelled position boxes. Click one for saved sequence evidence,
the confirmation gap, entry, stop and target. Results → Notes explains data
coverage and rejection counts; Matches explains signals skipped at entry.
Zero-trade runs show rejection counts and entry failures directly in Trades.
Missing complete 4H pairs or entirely unsynchronized comparisons produce an
explicit data error instead of a misleading successful zero-trade result.
Selecting a trade loads its historical candles even outside the current live
chart range. The entry timeframe follows the primary pane when charts are unlinked.

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
test start. An unexpired profile formed in warmup may confirm inside the test
window; invalidations and earlier entry attempts still consume that opportunity.
Test the earliest N signals, currently at most 25 (the existing app
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
The HTTP tests also run the actual scanner and simulator through POST/GET.
`cd frontend && npm run test:e2e` exercises submission, persistence, empty-run
diagnostics and historical chart display against an isolated fixture backend.
Install its browser once with `npx playwright install chromium`.
