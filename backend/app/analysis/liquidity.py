"""Liquidity pool detection -- clustered equal highs and equal lows.

From the review call, describing why a move had somewhere to go:

    "There are what's called low resistance liquidity, which are like highs
    that are not separated that much -- the distance between the highs is
    really close.  It's low resistance, so it should be swept."

A **pool** is two or more confirmed swing points of the same kind sitting at
effectively the same price.  Traders leave stops just beyond a level that has
held twice, so a shelf of equal highs is where resting orders accumulate;
price reaching for them is the mechanism behind both halves of what this
module is used for:

*As a destination.*  An unswept pool is where a move is likely to run to, which
is what makes it a target.  The same call, rejecting a target that was simply
far away: *"That's already 287 points, that's way too high.  I'll probably
just take it up to here"* -- the nearer shelf, not the furthest high on the
screen.

*As a trigger.*  A pool that has just been swept and rejected is the classic
reversal: the stops beyond it were taken, and the move that took them had no
follow-through.  A long wants the lows swept, not the highs.

Detection works from :mod:`app.analysis.structure` swing points rather than
from raw candle highs.  Raw highs would report a "pool" in every quiet range,
because consecutive bars in a range are all within a few ticks of each other
and none of them is a level anybody is watching.  A pool has to be built from
pivots -- the highs price has actually turned away from.

**Knowability.**  Like every other detector here, a pool carries the moment it
became usable and consumers must gate on that.  Two separate moments matter
and conflating them is the hindsight bug this package keeps warning about:

``formed_time``   when the pool exists -- the ``confirmed_time`` of its last
                  member, since a pivot is not known to be a pivot until its
                  confirmation window closes.
``swept_time``    when price traded beyond it, which is strictly later and is
                  the moment a sweep-based entry may act on.

**The level is the extreme, not the average.**  For a shelf of highs the pool
sits at the *highest* of them.  Anything lower leaves some of the resting
orders untouched, so a lower level would call a sweep that did not clear the
shelf and would set a target price never actually reached.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from app.models.domain import Candle
from app.analysis.structure import SwingPoint

PoolKind = Literal["high", "low"]

#: How far apart two pivots may sit and still count as the same level, as a
#: percentage of price.  0.03% is about 9 points on an index future near
#: 29,500 and about a third of a point on a 1,000-tick instrument, which is
#: what a percentage buys over a fixed distance: one number that means the
#: same thing across the instruments here.
#:
#: Deliberately tight.  Widening it does not find more pools, it merges
#: distinct levels into one and moves the reported price away from anything a
#: trader marked -- and since the level is the extreme of the cluster, a loose
#: tolerance drags targets upward into prices that were never tested.
DEFAULT_TOLERANCE_PERCENT = 0.03

#: Pivots needed before a level counts.  A single swing high is a high; the
#: whole idea here is the shelf that forms when price fails twice at one
#: price, so one touch is not a pool by definition rather than by threshold.
DEFAULT_MIN_TOUCHES = 2


@dataclass(frozen=True)
class LiquidityPool:
    """One shelf of equal highs or equal lows, and whether it still stands."""

    symbol: str
    kind: PoolKind
    #: The level itself: the highest high of a high pool, the lowest low of a
    #: low pool.  Clearing this price is what takes the whole shelf.
    price: float
    #: Time of the earliest pivot in the shelf -- where the zone starts on a
    #: chart.
    start_time: int
    #: Time of the latest pivot in the shelf.
    end_time: int
    #: When the pool became knowable: the last member's ``confirmed_time``.
    formed_time: int
    #: Pivots making up the shelf, in time order.
    touches: tuple[SwingPoint, ...]
    #: Price range across the members.  Small means tight, and a tight shelf
    #: is the "low resistance" one -- the stops sit in one place rather than
    #: smeared over a range price has to grind through.
    spread: float
    spread_percent: float
    swept: bool
    swept_time: int | None

    @property
    def touch_count(self) -> int:
        """How many pivots formed the shelf.

        More touches is more resting liquidity, and is the field to sort on
        when choosing between pools rather than taking the nearest.
        """

        return len(self.touches)


def find_liquidity_pools(
    candles: list[Candle],
    swings: list[SwingPoint],
    *,
    tolerance_percent: float = DEFAULT_TOLERANCE_PERCENT,
    min_touches: int = DEFAULT_MIN_TOUCHES,
) -> list[LiquidityPool]:
    """Group ``swings`` into shelves and mark which ones price has taken.

    ``candles`` is the series the swings came from; it is walked once per pool
    to find the sweep.

    **A shelf is emitted at every size it has ever been**, not once at its
    final size.  A level that had held twice by Tuesday was a real, usable
    level on Tuesday, and reporting only the four-touch version it grew into
    by Friday would hide it from every question asked between the two -- a
    candle on Friday deciding whether Tuesday's trade was taken.  Each prefix
    carries its own ``formed_time``, its own extreme and its own sweep, so a
    caller gating on ``formed_time`` sees the shelf exactly as it stood.

    The bias this removes ran the safe way -- it hid levels rather than
    inventing them -- but "wrong in the conservative direction" is still
    wrong, and it was not random: it dropped precisely the matches where
    price later came back and re-pivoted at the target.

    Swept shelves are always included.  Filtering them here would mean asking
    "has this been taken *by the end of the series*", which is a fact about
    the future of every entry in it; callers that only want standing levels
    must ask as of a moment, which is what :func:`nearest_unswept_pool` does.
    Display code that wants a tidy list wants :func:`maximal_pools` instead.
    """

    if tolerance_percent < 0:
        raise ValueError("tolerance_percent must not be negative")
    if min_touches < 2:
        raise ValueError("min_touches must be at least 2")
    if not candles or not swings:
        return []

    symbol = candles[0].symbol
    pools: list[LiquidityPool] = []

    for kind in ("high", "low"):
        members = [point for point in swings if point.kind == kind]
        for cluster in _clusters(members, tolerance_percent, min_touches):
            for size in range(min_touches, len(cluster) + 1):
                pools.append(_build(symbol, kind, cluster[:size], candles))

    pools.sort(key=lambda pool: (pool.formed_time, pool.price))
    return pools


def maximal_pools(pools: list[LiquidityPool]) -> list[LiquidityPool]:
    """One entry per shelf: the largest each one grew to.

    :func:`find_liquidity_pools` emits every size a shelf has been, which is
    what a time-gated question needs and is the wrong thing to draw -- four
    near-identical lines for one level is not four levels.  Prefixes of the
    same shelf share a ``kind`` and a first pivot, so that pair identifies
    them without any extra bookkeeping.
    """

    best: dict[tuple[str, int], LiquidityPool] = {}
    for pool in pools:
        key = (pool.kind, pool.start_time)
        current = best.get(key)
        if current is None or pool.touch_count > current.touch_count:
            best[key] = pool
    return sorted(best.values(), key=lambda pool: (pool.formed_time, pool.price))


def _clusters(
    points: list[SwingPoint],
    tolerance_percent: float,
    min_touches: int,
) -> list[list[SwingPoint]]:
    """Walk pivots in time order, grouping ones that sit at the same price.

    Membership is tested against the *anchor* -- the pivot that opened the
    cluster -- and not against the running mean of the cluster so far.  Against
    a moving mean a slowly drifting sequence chains indefinitely, each step
    inside the tolerance while the ends are nowhere near each other, and the
    result is a "level" spanning a range no trader would draw as one.

    A pivot that does not fit the open cluster starts a new one.  It is not
    tested against older clusters: a shelf is a thing that forms over a
    stretch of time, and letting a pivot rejoin a cluster from hours earlier
    would report a shelf whose members never coexisted as a visible level.
    """

    clusters: list[list[SwingPoint]] = []
    current: list[SwingPoint] = []

    for point in points:
        if not current:
            current = [point]
            continue

        anchor = current[0].price
        # Tolerance scales with the anchor's own price so the same percentage
        # means the same thing wherever the instrument trades.
        allowed = abs(anchor) * tolerance_percent / 100.0
        if abs(point.price - anchor) <= allowed:
            current.append(point)
            continue

        if len(current) >= min_touches:
            clusters.append(current)
        current = [point]

    if len(current) >= min_touches:
        clusters.append(current)

    return clusters


def _build(
    symbol: str,
    kind: PoolKind,
    cluster: list[SwingPoint],
    candles: list[Candle],
) -> LiquidityPool:
    """Assemble one pool and find the candle that swept it, if any."""

    prices = [point.price for point in cluster]
    price = max(prices) if kind == "high" else min(prices)
    spread = max(prices) - min(prices)
    # The pool is not usable until its last pivot confirms, so that -- not the
    # pivot's own bar -- is when it starts to exist.
    formed_time = max(point.confirmed_time for point in cluster)

    swept_time = _sweep_time(candles, kind, price, formed_time)

    return LiquidityPool(
        symbol=symbol,
        kind=kind,
        price=price,
        start_time=cluster[0].time,
        end_time=cluster[-1].time,
        formed_time=formed_time,
        touches=tuple(cluster),
        spread=spread,
        spread_percent=(spread / abs(price) * 100.0) if price else 0.0,
        swept=swept_time is not None,
        swept_time=swept_time,
    )


def _sweep_time(
    candles: list[Candle],
    kind: PoolKind,
    price: float,
    formed_time: int,
) -> int | None:
    """First candle from ``formed_time`` on to trade beyond ``price``.

    **Strictly** beyond: trading *to* a level is not taking the orders resting
    past it, and a shelf that has merely been touched again is a shelf with
    one more touch, not a swept one.

    Starting the scan at ``formed_time`` rather than at the last pivot loses
    nothing.  The last member is a swing point, so by definition no candle in
    its confirmation window exceeds it -- and the pool's price is at least the
    last member's price -- so no candle between the pivot and its confirmation
    can have cleared the level.
    """

    for candle in candles:
        if candle.time < formed_time:
            continue
        if kind == "high":
            if candle.high > price:
                return candle.time
        elif candle.low < price:
            return candle.time
    return None


def pools_swept_before(
    pools: list[LiquidityPool],
    kind: PoolKind,
    time: int,
    *,
    within_ms: int | None = None,
) -> list[LiquidityPool]:
    """Pools of ``kind`` swept at or before ``time``, most recent first.

    The window, when given, is measured from the *sweep* rather than from when
    the pool formed.  A shelf that built up over a fortnight and was taken out
    ten minutes ago is a fresh reason to trade; the fortnight is not the
    staleness that matters.
    """

    matches = [
        pool
        for pool in pools
        if pool.kind == kind
        and pool.swept
        and pool.swept_time is not None
        and pool.swept_time <= time
        and (within_ms is None or time - pool.swept_time <= within_ms)
    ]
    matches.sort(key=lambda pool: pool.swept_time or 0, reverse=True)
    return matches


def nearest_unswept_pool(
    pools: list[LiquidityPool],
    kind: PoolKind,
    *,
    price: float,
    time: int,
) -> LiquidityPool | None:
    """Closest standing shelf beyond ``price``, as known at ``time``.

    "Beyond" is directional: a high pool must sit above the price to be
    somewhere a long can run to, and a low pool below it for a short.  A pool
    on the wrong side of the entry is behind the trade, not in front of it.

    Nearest rather than largest.  The question this answers is where the move
    is likely to *reach*, and every shelf in between has to be cleared first --
    so the first one is the one with the odds, whatever is stacked behind it.

    A pool swept after ``time`` still counts as standing here.  Its sweep is
    the future of this moment, and reading it would be exactly the hindsight
    the rest of this package is careful to avoid: a target chosen because it
    was about to be hit.
    """

    best: LiquidityPool | None = None
    for pool in pools:
        if pool.kind != kind:
            continue
        if pool.formed_time > time:
            continue  # Not yet knowable.
        if pool.swept and pool.swept_time is not None and pool.swept_time <= time:
            continue  # Already taken; the orders are gone.
        if kind == "high" and pool.price <= price:
            continue
        if kind == "low" and pool.price >= price:
            continue
        if best is None or abs(pool.price - price) < abs(best.price - price):
            best = pool
    return best
