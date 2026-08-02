"""Event-based backtesting engine.

The engine is deliberately transparent: every trade walks forward through real
candles one bar at a time and records exactly why it exited.  There is no
vectorised shortcut that could quietly look at future data.

Documented modelling assumptions (surfaced in the UI):

* **Same-bar ambiguity.** If a single candle touches both the stop and the
  target, we cannot know which came first without lower-timeframe data, so the
  **stop loss is assumed to trigger first**.  Every affected trade is flagged
  and counted.
* **Gaps.** If a bar opens beyond the stop or target, the fill happens at the
  open, not at the level -- gaps are not assumed to be filled at your price.
* **Slippage** worsens both entry and exit prices by ``slippage_percent``.
* **Fees** are charged as ``fee_percent`` of notional on entry *and* exit.
* **Timeout.** A position still open after ``maximum_holding_bars`` closes at
  that bar's close.
* Returns are expressed in percent of the entry price; position sizing,
  margin, contract multipliers and financing are out of scope.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.models.domain import Candle
from app.models.schemas import TradeRules

logger = logging.getLogger(__name__)

ASSUMPTIONS: list[str] = [
    "When one candle touches both the stop loss and the take profit, the stop loss "
    "is assumed to trigger first (conservative).",
    "A bar that opens beyond the stop or target fills at the open price, not at the level.",
    "Slippage worsens both the entry and the exit price.",
    "Fees are charged on entry and exit, as a percentage of notional.",
    "Positions still open after the maximum holding period close at that bar's close.",
    "Returns are percentages of the entry price; contract multipliers, margin and "
    "financing costs are not modelled.",
    "Historical matches are found by deterministic feature comparison, not by a "
    "trained model.",
]


@dataclass
class SimulatedTrade:
    """A single simulated position."""

    pattern_match_id: str
    symbol: str
    direction: str
    entry_index: int
    exit_index: int
    entry_time: int
    exit_time: int
    entry_price: float
    exit_price: float
    stop_price: float
    target_price: float
    gross_return: float
    fees: float
    net_return: float
    exit_reason: str
    holding_bars: int
    similarity_score: float
    same_bar_ambiguity: bool


@dataclass
class SkippedMatch:
    pattern_match_id: str
    reason: str


@dataclass
class MatchInput:
    """What the engine needs to know about one historical match."""

    id: str
    start_index: int
    end_index: int
    similarity: float


class BacktestEngine:
    """Simulates the configured rules over a list of historical matches."""

    def __init__(self, candles: list[Candle], rules: TradeRules) -> None:
        self._candles = candles
        self._rules = rules
        self._true_ranges = _true_ranges(candles)

    # ------------------------------------------------------------------
    def run(self, matches: list[MatchInput]) -> tuple[list[SimulatedTrade], list[SkippedMatch]]:
        trades: list[SimulatedTrade] = []
        skipped: list[SkippedMatch] = []
        last_exit_time = -1

        # Chronological order matters for the overlap rule.
        for match in sorted(matches, key=lambda item: item.end_index):
            try:
                trade = self._simulate(match)
            except _SkipMatch as exc:
                skipped.append(SkippedMatch(match.id, str(exc)))
                continue

            if not self._rules.allow_overlapping_trades and trade.entry_time < last_exit_time:
                skipped.append(
                    SkippedMatch(match.id, "Overlaps an earlier trade that was still open")
                )
                continue

            last_exit_time = max(last_exit_time, trade.exit_time)
            trades.append(trade)

        trades.sort(key=lambda item: item.entry_time)
        return trades, skipped

    # ------------------------------------------------------------------
    def _simulate(self, match: MatchInput) -> SimulatedTrade:
        rules = self._rules
        candles = self._candles
        long = rules.direction == "long"

        if rules.entry_type == "next_open":
            entry_index = match.end_index + 1
            if entry_index >= len(candles):
                raise _SkipMatch("No candle available after the pattern for a next-open entry")
            raw_entry = candles[entry_index].open
            first_scan_index = entry_index
        else:
            entry_index = match.end_index
            raw_entry = candles[entry_index].close
            first_scan_index = entry_index + 1

        if first_scan_index >= len(candles):
            raise _SkipMatch("No future candles available to simulate the trade")

        entry_price = _apply_slippage(raw_entry, rules.slippage_percent, worsen_up=long)
        stop_price = self._stop_price(match, entry_price, long)
        target_price = self._target_price(entry_price, stop_price, long)

        self._validate_levels(entry_price, stop_price, target_price, long)

        last_index = min(
            first_scan_index + rules.maximum_holding_bars - 1,
            len(candles) - 1,
        )

        same_bar = False

        for index in range(first_scan_index, last_index + 1):
            candle = candles[index]
            hit_stop = candle.low <= stop_price if long else candle.high >= stop_price
            hit_target = candle.high >= target_price if long else candle.low <= target_price

            if hit_stop and hit_target:
                # Conservative: assume the stop came first.
                same_bar = True
                exit_index = index
                exit_reason = "stop_loss"
                raw_exit = _fill_price(candle.open, stop_price, long, is_stop=True)
                break
            if hit_stop:
                exit_index = index
                exit_reason = "stop_loss"
                raw_exit = _fill_price(candle.open, stop_price, long, is_stop=True)
                break
            if hit_target:
                exit_index = index
                exit_reason = "take_profit"
                raw_exit = _fill_price(candle.open, target_price, long, is_stop=False)
                break
        else:
            exit_index = last_index
            raw_exit = candles[last_index].close
            exit_reason = (
                "timeout"
                if (last_index - first_scan_index + 1) >= rules.maximum_holding_bars
                else "end_of_data"
            )

        # Stop and target fills already account for the level being crossed;
        # slippage is applied on top, always against the position.
        exit_price = _apply_slippage(raw_exit, rules.slippage_percent, worsen_up=not long)

        direction_sign = 1.0 if long else -1.0
        gross_return = direction_sign * (exit_price - entry_price) / entry_price * 100.0
        fees = rules.fee_percent * 2.0
        net_return = gross_return - fees

        return SimulatedTrade(
            pattern_match_id=match.id,
            symbol=candles[entry_index].symbol,
            direction=rules.direction,
            entry_index=entry_index,
            exit_index=exit_index,
            entry_time=candles[entry_index].time,
            exit_time=candles[exit_index].time,
            entry_price=round(entry_price, 6),
            exit_price=round(exit_price, 6),
            stop_price=round(stop_price, 6),
            target_price=round(target_price, 6),
            gross_return=round(gross_return, 6),
            fees=round(fees, 6),
            net_return=round(net_return, 6),
            exit_reason=exit_reason,
            holding_bars=exit_index - entry_index + 1,
            similarity_score=match.similarity,
            same_bar_ambiguity=same_bar,
        )

    # ------------------------------------------------------------------
    def _stop_price(self, match: MatchInput, entry_price: float, long: bool) -> float:
        rules = self._rules
        kind = rules.stop_loss_type
        value = rules.stop_loss_value

        if kind == "percentage":
            offset = entry_price * value / 100.0
            return entry_price - offset if long else entry_price + offset
        if kind == "fixed_price":
            return value
        if kind == "pattern_extreme":
            window = self._candles[match.start_index : match.end_index + 1]
            if not window:
                raise _SkipMatch("Pattern window is empty")
            return min(candle.low for candle in window) if long else max(
                candle.high for candle in window
            )
        if kind == "atr_multiple":
            atr = self._atr(match.end_index, rules.atr_period)
            if atr <= 0:
                raise _SkipMatch("ATR could not be computed for this match")
            offset = atr * value
            return entry_price - offset if long else entry_price + offset
        raise _SkipMatch(f"Unsupported stop-loss type '{kind}'")

    def _target_price(self, entry_price: float, stop_price: float, long: bool) -> float:
        rules = self._rules
        kind = rules.take_profit_type
        value = rules.take_profit_value

        if kind == "percentage":
            offset = entry_price * value / 100.0
            return entry_price + offset if long else entry_price - offset
        if kind == "fixed_price":
            return value
        if kind == "risk_reward":
            risk = abs(entry_price - stop_price)
            if risk <= 0:
                raise _SkipMatch("Stop loss sits at the entry price, so risk is zero")
            offset = risk * value
            return entry_price + offset if long else entry_price - offset
        raise _SkipMatch(f"Unsupported take-profit type '{kind}'")

    def _atr(self, index: int, period: int) -> float:
        start = max(1, index - period + 1)
        window = self._true_ranges[start : index + 1]
        if not window:
            return 0.0
        return sum(window) / len(window)

    @staticmethod
    def _validate_levels(entry: float, stop: float, target: float, long: bool) -> None:
        if long:
            if stop >= entry:
                raise _SkipMatch("Stop loss is at or above the entry price for a long trade")
            if target <= entry:
                raise _SkipMatch("Take profit is at or below the entry price for a long trade")
        else:
            if stop <= entry:
                raise _SkipMatch("Stop loss is at or below the entry price for a short trade")
            if target >= entry:
                raise _SkipMatch("Take profit is at or above the entry price for a short trade")


class _SkipMatch(Exception):
    """Internal signal that a match cannot produce a valid trade."""


def _apply_slippage(price: float, slippage_percent: float, *, worsen_up: bool) -> float:
    """Move ``price`` against the trader by ``slippage_percent``."""

    factor = slippage_percent / 100.0
    return price * (1.0 + factor) if worsen_up else price * (1.0 - factor)


def _fill_price(open_price: float, level: float, long: bool, *, is_stop: bool) -> float:
    """Fill at the level, unless the bar gapped straight through it.

    A long stop sits below the market, so an open below it fills worse; a long
    target sits above, so an open above it fills better.  Shorts mirror this.
    """

    below_is_worse = is_stop if long else not is_stop
    return min(open_price, level) if below_is_worse else max(open_price, level)


def _true_ranges(candles: list[Candle]) -> list[float]:
    ranges: list[float] = [0.0] * len(candles)
    for index in range(1, len(candles)):
        current = candles[index]
        previous_close = candles[index - 1].close
        ranges[index] = max(
            current.high - current.low,
            abs(current.high - previous_close),
            abs(current.low - previous_close),
        )
    if candles:
        ranges[0] = candles[0].high - candles[0].low
    return ranges
