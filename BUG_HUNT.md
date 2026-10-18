# Bug hunt — 18 October 2026

102 defects confirmed (2 critical, 11 high, 63 medium, 26 low) by a browser pass
over the running app, a Codex review of the backend trading logic, three Claude
reviewers (data layer, frontend state, components) and a Codex review of the
finished diff, which caught four problems in the fixes themselves. A second
pass over the drawing tools -- every tool created, edited, undone and reloaded
by hand, and a Codex review of the drawing code -- found fifteen more, and
the one limitation the first pass had left open was fixed on request. A
third pass made the price live and hardened what was left (nine more), and
a fourth put CME's holidays in the trading calendar; a Codex review of those
two passes found five more in them, all fixed. All are
fixed with a regression test that fails on the old code, except where noted.
The full report and the tracker live outside the repo, in
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
- History older than anything Massive has served for a series is asked for
  once: an empty answer there is recorded as answered rather than demoting
  Massive on every view, and the window reads as partial, naming the date the
  vendor's history starts. Holes inside the history it holds still count as
  failures.
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
- The second drawing pass: drawings follow the price axis when it is dragged
  (they stayed at their old height); a note just dropped takes the keyboard,
  where typing had run the F and R shortcuts and Backspace deleted it; a
  position's stop and target stay on their side of the entry, its end stays a
  bar after it, and the R label is signed; the long/short preview is the box
  the release places; an undo pressed mid-drag stays undone; Delete no longer
  reaches a drawing on a market that has left the screen; a click on an axis
  no longer finishes a two-click shape; a ray runs on in whichever direction
  it was drawn and can be grabbed by its extension; a setup cannot be marked
  across the previous interval's bars while the new ones load; and labels use
  the instrument's precision (YM in whole points); a note's plate is sized
  for the widest system monospace face, not only Windows' Consolas.
- With a drawing tool held, the price and time axes can be dragged and the
  wheel zooms: the overlay is clipped to the candle area, the same rectangle
  its paint already was, and hands the wheel to the chart.
- Panels use the primary pane's own interval; runs survive the panel
  unmounting; trade evidence is read per trade and states what it could not
  load; menus take and
  return keyboard focus; number fields refuse fractional or out-of-range
  values; hint text is readable; daily+ bars are labelled by trading day.
- "Describe it" honours negation, ratios like 1:3, leading-dot decimals and
  trade verbs over adjectives, and reads each phrase for one setting.

## Live price and hardening (third pass)

- The price is live: each chart asks for its bars again every minute while
  CME futures trade (Sunday 17:00 to Friday 16:00 Chicago, less the daily
  halt), and on refocus -- never over a weekend or in a background tab. It
  had asked once an hour, so the price on screen could be most of an hour
  old. About one Massive call per chart per minute, inside the quota of five.
  Detections are worked out again when a new bar opens.
- The legend's change is the day's -- since the previous session's close --
  not the move over the whole loaded history.
- Clear drawings takes only the drawings on the charts on screen, and a
  second tab of the app no longer overwrites the first one's drawings.
- A backtest on a minute chart searches what that chart can load (seven days
  on 1m), not 180 days of minute bars; the panel says so, and says which
  markets a run searches and which it only reads for SMT.
- Saved runs from the same minute are told apart; result tile names wrap
  instead of being cut off; selected menu rows read at about 8:1.

## CME holidays (fourth pass)

- Both calendars -- the backend's, which judges whether an empty provider
  answer is an outage and which gaps to re-ask, and the frontend's, which
  decides when the live chart polls -- now know CME's holiday closures for the
  equity index futures: 25 of them, Thanksgiving 2025 to Christmas 2027, read
  from CME's own trading-hours service, not worked out from holiday names
  (Good Friday 2026 is an abbreviated session to 08:15 CT, not a closure).
  Holidays before 19 October 2025, which the service does not hold, still read
  as trading days. A test keeps the two copies of the list identical.

## Codex review of the last two passes

- A tab taking up another tab's drawings no longer writes them back -- the
  echo let two tabs trade saves for ever -- and skips a save a later one has
  replaced; a stored drawing this build cannot paint is refused or dropped
  instead of breaking the overlay.
- Detections refresh at most once in five minutes, which keeps unlinked
  fine-interval charts inside the provider quota.
- Open time is counted exactly, quarter hour by quarter hour, so the half hour
  after a reopen is no longer half missed.
- The GXT run uses the same lookback cap as the pattern run.

## Worth knowing

- The holiday list in `backend/app/providers/trading_hours.py` (mirrored in
  `frontend/src/lib/marketHours.ts`) ends with Christmas 2027. Refresh it once
  a year from the same source; CME confirms each holiday's hours about two
  weeks ahead.
- History recorded as older than Massive's archive is not asked for again. If
  the archive grows -- a plan upgrade -- clear the cache for that market
  (`DELETE /api/cache?symbol=ES`) to pull the older bars in.

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
