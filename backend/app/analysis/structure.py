"""Swing-point detection.

A **swing high** is a candle whose high is not exceeded by the ``strength``
candles on either side of it -- the "candle that sticks out" a trader connects
lines between.  A **swing low** is the mirror image on lows.

Two properties matter for backtesting honesty:

*Confirmation delay.*  A swing point cannot be known until ``strength``
candles have printed after it.  The final ``strength`` candles of a series are
therefore never labelled, and every point carries the timestamp of the candle
that confirmed it.  Consumers that place trades must use
``confirmed_time``, not ``time``, or they are trading on information that did
not exist yet.

*Plateaus.*  Equal highs would otherwise produce two "swing highs" for what a
trader reads as one level.  A candle must be **strictly** higher than
everything to its left and **at least equal** to everything on its right, so a
flat double top reports its first candle only.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

import numpy as np

from app.models.domain import Candle

SwingKind = Literal["high", "low"]

#: Bars either side that must fail to exceed the pivot. 2 is the common ICT
#: default; 1 reduces to the classic three-candle fractal.
DEFAULT_STRENGTH = 2


@dataclass(frozen=True)
class SwingPoint:
    """One confirmed pivot in the series."""

    symbol: str
    kind: SwingKind
    index: int
    time: int
    price: float
    #: Time of the candle that completed the confirmation window.
    confirmed_time: int
    strength: int


def find_swing_points(
    candles: list[Candle],
    *,
    strength: int = DEFAULT_STRENGTH,
) -> list[SwingPoint]:
    """Return every confirmed swing high and low, ordered by time.

    ``strength`` is the number of candles either side that must not exceed the
    pivot.  Larger values report fewer, more significant points.
    """

    if strength < 1:
        raise ValueError("strength must be at least 1")

    window = 2 * strength + 1
    total = len(candles)
    if total < window:
        return []

    highs = np.array([candle.high for candle in candles], dtype=np.float64)
    lows = np.array([candle.low for candle in candles], dtype=np.float64)

    high_windows = np.lib.stride_tricks.sliding_window_view(highs, window)
    low_windows = np.lib.stride_tricks.sliding_window_view(lows, window)

    left = high_windows[:, :strength]
    right = high_windows[:, strength + 1 :]
    centre_high = high_windows[:, strength]
    is_swing_high = (centre_high > left.max(axis=1)) & (centre_high >= right.max(axis=1))

    left_low = low_windows[:, :strength]
    right_low = low_windows[:, strength + 1 :]
    centre_low = low_windows[:, strength]
    is_swing_low = (centre_low < left_low.min(axis=1)) & (centre_low <= right_low.min(axis=1))

    points: list[SwingPoint] = []
    symbol = candles[0].symbol

    for offset in np.flatnonzero(is_swing_high | is_swing_low):
        index = int(offset) + strength
        confirmed_index = index + strength
        candle = candles[index]
        confirmed_time = candles[confirmed_index].time

        # A candle can satisfy both tests only when the whole window is flat,
        # in which case neither strict comparison passes -- so at most one of
        # these appends runs.
        if is_swing_high[offset]:
            points.append(
                SwingPoint(
                    symbol=symbol,
                    kind="high",
                    index=index,
                    time=candle.time,
                    price=candle.high,
                    confirmed_time=confirmed_time,
                    strength=strength,
                )
            )
        if is_swing_low[offset]:
            points.append(
                SwingPoint(
                    symbol=symbol,
                    kind="low",
                    index=index,
                    time=candle.time,
                    price=candle.low,
                    confirmed_time=confirmed_time,
                    strength=strength,
                )
            )

    points.sort(key=lambda point: (point.time, point.kind))
    return points


def swing_points_by_kind(
    points: list[SwingPoint], kind: SwingKind
) -> list[SwingPoint]:
    """Filter to highs or lows, preserving chronological order."""

    return [point for point in points if point.kind == kind]
