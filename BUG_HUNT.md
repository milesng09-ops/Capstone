# Bug hunt — 8 October 2026

The fixes are implemented directly in the source on `codex/bug-hunt-fixes`.
No patch file is required to run, review, or merge them.

## Backtesting and learning

- Resolve gaps at the opening price before checking ambiguous intrabar exits,
  for both long and short trades.
- Keep masked/self-overlapping candidates out of the learned top-k mean even
  when fewer than k eligible candidates remain.
- Drop training labels whose exit bar closes beyond the train/test boundary;
  holdout windows must start after the training stretch and resolve inside
  the lookback.
- Exclude the training stretch from the random baseline on every symbol.
- Apply the no-overlap rule to the combined chronological portfolio, then
  persist and report the accepted trades and skipped count.
- Stop compounded equity at zero after a loss of 100% or more.
- Reject a gap filled on the entry bar as evidence for a close entry.
- Evaluate close-entry session filters at the bar's close.

## Data and API

- Expand missing cache fetches to complete storage buckets before aggregating
  finer bars, preserving the OHLCV at both edges.
- Size analysis slices using the stored interval and intraday history cap.
  Partial final hours no longer round up to a whole hour in request sizing.
- Roll quarterly futures at 17:00 Chicago on the evening before the roll
  trading date, so one session uses one contract, including across DST.
- Require bias intervals to be composed of whole entry bars; compute calendar
  bias availability from the actual week/month close boundary.
- Return HTTP 400 for nonfinite timestamps and normalize cache-delete symbols.
- Isolate fallback-provider tests from developer credentials and report zero
  pacing wait when a rate-limiter caller was admitted immediately.

## Strategy and chart UI

- Cap presets, descriptions, and requests at 25 matches. Keep other parsed
  numeric settings inside backend constraints and display the applied values.
- Reading a description replaces the strategy with defaults plus the fields
  mentioned, including search markets.
- Recognize percentage stop-loss phrases and avoid reading wick adjectives
  and buy-side/sell-side liquidity as position directions.
- Offer valid bias interval pairs, repair saved incompatible pairs when
  constructing a request, and disable unavailable bias filters.
- Estimate liquidity position sizing from the minimum R floor and label the
  target as a minimum. Describe liquidity exits accurately in trade evidence.
- Show signed drawdown in the equity tooltip and an undefined achieved R:R
  when there is no losing trade.
- Reapply candle colours and volume visibility, reload data, and fit each
  rebuilt chart, even when the interval remains unchanged.
- Cancel pending drawings on tool changes, preserve dropdown keyboard focus,
  measure drawing toolbars to keep their controls in the pane, and close the
  timeframe menu when the inline strip is used.
- Declare Node type definitions explicitly for clean frontend installs.

## Validation

The starting checkout passed 545 backend tests and 454 frontend tests.
Regression cases reproduced the principal failures before their fixes.
The added API test exercises a complete two-symbol run and reloads its saved
result; the cache test verifies full aggregate volumes at the fetch edges.
Browser tests use deterministic stub data and make no market-provider calls.

Final checks:

- Backend: 579 tests.
- Frontend: 475 tests across 26 files.
- Typecheck and production build.
- Playwright: 22 Chromium tests, including note-toolbar containment and
  keyboard focus in a dropdown.

## Behaviour changes

- Pairs such as 1h → 90m, 90m → 4h, and 4h → 6h are rejected. On 1h, the
  first valid bias interval is 4h. Weekly bars cannot use monthly bias.
- A description resets unmentioned strategy fields to defaults.
- Liquidity targets in sizing are minimum estimates, not an identified pool.
- The no-overlap option applies across all searched symbols.
- Training and baseline comparisons exclude data used by the fitted model.

## Remaining modelling limitations

- A next-open entry can still share a bar with a previous intrabar exit.
- Some bias evidence is admitted one entry bar later than necessary.
- The newest live cache bucket may be partial while it is forming.

These modelling choices require a separate behaviour decision; they were not
changed by this fix set.
