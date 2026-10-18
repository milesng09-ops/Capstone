# Bug hunt — 18 October 2026

71 defects confirmed (2 critical, 9 high, 44 medium, 16 low) by a browser pass
over the running app, a Codex review of the backend trading logic, three Claude
reviewers (data layer, frontend state, components) and a Codex review of the
finished diff, which caught four problems in the fixes themselves. All are
fixed in the working tree with a regression test that fails on the old code,
except where noted. The full report and the tracker live outside the repo, in
`qa-evidence/Miles-2026-10-18/` (`report.md`, `bugs.xlsx`).

## The two critical ones

- The chart overlay never painted under `npm run dev`. StrictMode's rehearsal
  unmount cancelled the first animation frame but left its handle in the ref,
  so every later repaint request returned early: no drawings, setup band,
  trade boxes or detector overlays. The geometry e2e specs passed throughout;
  `e2e/overlay-paint.spec.ts` now reads the canvas's pixels back.
- A workspace saved by an earlier build blanked the app on every load: persist
  only migrates on a version change, and new detector fields arrived without
  one. Persisted objects are now filled from their defaults on every load (v5).

## Backtesting and statistics

- The selection's dates are excluded on every searched symbol, in the search
  and the random baseline. Kept, the same move on ES/YM came back as the best
  "matches" of an NQ setup and was scored.
- An SMT condition on a single named market reads its partner from the charted
  markets as a reference only: compared against, never searched or traded.
- The equity curve and max drawdown compound in the order trades closed.
- SMT validity waits for the reference market's own swing confirmation.
- A Fibonacci entry needs the leg to be the newest structure on the chart.
- The attempt count forks on fitted weights and the bias timeframe; the
  family-wise odds are corrected from the unrounded p-value; overlapping trades
  add a note that the interval treats them as independent.
- NaN / infinity stop and target values are a 422, not a 500.

## Data and API

- A one-bar seam between two cached spans is no longer re-fetched forever
  (regression from 8 Oct); weekly/monthly bars at a window or chunk edge are
  built whole; a preferred provider takes a series back from a fallback owner;
  and a series read across that takeover is read again from one provider;
  the forming-tail memo holds after failures and over weekends; a rate limit is
  reported as a wait; analysis ranges are capped; empty answers for the future
  no longer demote Massive; timestamps outside 1970-2100 are refused; SQLite
  waits 30 s for a busy writer.
- A five-candle selection is accepted.

## Charts, drawings and panels

- Drawings anchored between bars no longer jump to the left edge on another
  timeframe; charts refit on a new interval or history span; overlays are
  clipped to the plot, and no shape starts on an axis; the range tabs sit below
  the legend; volume is off the price axis; layouts keep their charts; drags
  move by bars; right-click, pointer cancel and symbol switches no longer
  corrupt a gesture.
- The magnet is a weak one: it takes a bar's open/high/low/close only within
  12px of the pointer, so a dragged end follows the cursor instead of sticking
  to the high or low.
- Panels use the primary pane's own interval; runs survive the panel
  unmounting; trade evidence is read per trade and states what it could not
  load; menus take and
  return keyboard focus; number fields refuse fractional or out-of-range
  values; hint text is readable; daily+ bars are labelled by trading day.
- "Describe it" honours negation, ratios like 1:3, leading-dot decimals and
  trade verbs over adjectives, and reads each phrase for one setting.

## Left open

- When Massive's history starts inside the requested window, the older stretch
  is re-asked on each request and demotes Massive for 120 s. Fixing it means
  remembering the earliest bar served -- a policy decision, since it could also
  hide a real gap in the vendor's data.

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
