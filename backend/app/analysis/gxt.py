"""Causal, deliberately provisional GXT research hypothesis.

This is NOT a transcription of Garrett's complete model, PSP, or Strength
Switch. See backend/GXT_RESEARCH.md for the exact executable definition.
All timestamps are bar opens except explicit `confirmed_at` timestamps.
"""

from __future__ import annotations

from bisect import bisect_left
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from math import isfinite
from zoneinfo import ZoneInfo

from app.models.domain import Candle
from app.models.schemas import GxtEvidence, GxtSettings
from app.services.aggregation_service import bucket_start
from app.utils.intervals import HOUR_MS, interval_ms

FOUR_HOURS = 4 * HOUR_MS
NY = ZoneInfo("America/New_York")
ALLOWED_INTERVALS = {"1m", "2m", "3m", "5m", "15m", "30m", "1h"}


@dataclass(frozen=True)
class GxtSignal:
    start_index: int
    end_index: int
    expires_at: int
    evidence: GxtEvidence


def complete_profiles(candles: list[Candle], step: int, as_of: int) -> dict[int, Candle]:
    """Only full contiguous 4H buckets; partial/shortened sessions are skipped."""
    groups: dict[int, list[Candle]] = defaultdict(list)
    previous = -1
    for bar in candles:
        if bar.time <= previous:
            raise ValueError("GXT data must have unique, increasing timestamps.")
        previous = bar.time
        if not all(isfinite(v) and v > 0 for v in (bar.open, bar.high, bar.low, bar.close)):
            raise ValueError("GXT data contains a non-finite or non-positive price.")
        if not bar.low <= min(bar.open, bar.close) <= max(bar.open, bar.close) <= bar.high:
            raise ValueError("GXT data contains inconsistent OHLC values.")
        groups[bucket_start(bar.time, "4h")].append(bar)
    complete = {}
    for start, bars in groups.items():
        if start + FOUR_HOURS > as_of or len(bars) != FOUR_HOURS // step:
            continue
        if any(bar.time != start + i * step for i, bar in enumerate(bars)):
            continue
        complete[start] = Candle(
            symbol=bars[0].symbol, time=start, open=bars[0].open,
            high=max(b.high for b in bars), low=min(b.low for b in bars),
            close=bars[-1].close, volume=sum(b.volume for b in bars),
        )
    return complete


def hourly_profiles(candles: list[Candle], step: int, as_of: int) -> dict[int, Candle]:
    """Strict closed 1H swings, never inferred from a forming hour."""
    groups: dict[int, list[Candle]] = defaultdict(list)
    for bar in candles:
        groups[bar.time // HOUR_MS * HOUR_MS].append(bar)
    result = {}
    for start, bars in groups.items():
        if start + HOUR_MS > as_of or len(bars) != HOUR_MS // step:
            continue
        if any(b.time != start + i * step for i, b in enumerate(bars)):
            continue
        result[start] = Candle(symbol=bars[0].symbol, time=start, open=bars[0].open,
            high=max(b.high for b in bars), low=min(b.low for b in bars),
            close=bars[-1].close, volume=sum(b.volume for b in bars))
    return result


def find_c2_continuations(candles, references, *, interval, settings, tick_size, start, end):
    """Source-linked subset: new 4H open inside 1H C3 after a closed C2 reversal.

    Sources: BueHY7EFUx0 01:26–03:00, ayW4VPUw2yk 00:32–01:01.
    Exact stop, target and divergence filter are our explicit research choices.
    This does not implement all three sequences, gap selection or PSP.
    """
    step = interval_ms(interval)
    profiles = complete_profiles(candles, step, end)  # also validates OHLC/order
    hours = hourly_profiles(candles, step, end)
    refs = {}
    for symbol, bars in references.items():
        complete_profiles(bars, step, end)  # same input validation
        refs[symbol] = hourly_profiles(bars, step, end)
    times = [b.time for b in candles]
    stats = Counter(complete_4h_profiles=len(profiles))
    signals = []
    for stamp, previous in sorted(profiles.items()):
        boundary = stamp + FOUR_HOURS
        if boundary < start or boundary >= end:
            continue
        c1, c2 = hours.get(boundary - 2*HOUR_MS), hours.get(boundary - HOUR_MS)
        if c1 is None or c2 is None:
            stats['missing_previous_4h'] += 1
            continue
        stats['eligible_4h_pairs'] += 1
        synchronized = all(c1.time in ref and c2.time in ref for ref in refs.values())
        if refs and synchronized:
            stats['synchronized_4h_pairs'] += 1
        low, high = c2.low < c1.low, c2.high > c1.high
        if low == high or (c2.close <= c1.low if low else c2.close >= c1.high):
            stats['no_single_sweep_reclaim'] += 1
            continue
        long = low
        direction = 'long' if long else 'short'
        if settings.direction not in {'both', direction}:
            stats['direction_rejected'] += 1
            continue
        stats['sweep_reclaim_profiles'] += 1
        divergent, opposed = [], []
        for symbol, ref in refs.items():
            r1, r2 = ref.get(c1.time), ref.get(c2.time)
            if r1 is None or r2 is None:
                continue
            if r2.low >= r1.low if long else r2.high <= r1.high:
                divergent.append(symbol)
            if r2.close < r2.open if long else r2.close > r2.open:
                opposed.append(symbol)
        if settings.require_cross_asset and (not synchronized or not divergent):
            stats['cross_asset_rejected'] += 1
            stats['cross_asset_data_missing' if not synchronized else 'no_cross_asset_divergence'] += 1
            continue
        first = bisect_left(times, boundary)
        if first < 1 or first >= len(candles) or candles[first].time != boundary or candles[first-1].time + step != boundary:
            stats['missing_entry_bar'] += 1
            continue
        local = datetime.fromtimestamp(boundary / 1000, NY)
        if settings.ny_morning_only and not 570 <= local.hour*60+local.minute < 660:
            stats['outside_ny_morning'] += 1
            continue
        evidence = GxtEvidence(
            sequence_model='c2_continuation', direction=direction, profile='1h_c2_sweep_reclaim',
            context_start=stamp, context_end=boundary, confirmed_at=boundary,
            signal_bar_time=candles[first-1].time, swept_level=c1.low if long else c1.high,
            stop_price=c2.low-tick_size*settings.stop_buffer_ticks if long else c2.high+tick_size*settings.stop_buffer_ticks,
            target_price=previous.high if long else previous.low,
            reference_symbols=divergent, opposed_close_symbols=opposed,
            entry_session_ny=local.isoformat(),
            source_links=['https://www.youtube.com/watch?v=BueHY7EFUx0&t=86',
                          'https://www.youtube.com/watch?v=ayW4VPUw2yk&t=32'],
            steps=[
                'A complete prior 4H candle contains two complete final 1H candles, C1 and C2.',
                'The final 1H C2 sweeps one C1 extreme and closes back beyond it, confirming the reversal.',
                'The new 4H candle opens at the start of 1H C3; the swing is already confirmed before entry.',
                'Optional matched-hour sweep divergence is an additional research filter, not verified PSP.',
                'Research execution: next 4H open, stop beyond 1H C2, target the prior 4H extreme; validate entry reward/risk.',
            ],
        )
        signals.append(GxtSignal(bisect_left(times, stamp), first-1, boundary+FOUR_HOURS, evidence))
        stats['confirmed_signals'] += 1
    return signals, dict(stats)


def find_gxt_signals(
    candles: list[Candle], references: dict[str, list[Candle]], *,
    interval: str, settings: GxtSettings, tick_size: float,
    start: int, end: int,
) -> tuple[list[GxtSignal], dict[str, int]]:
    if interval not in ALLOWED_INTERVALS:
        raise ValueError("GXT research needs a 1m–1h interval that divides 4H (90m is unsupported).")
    if settings.sequence_model == 'c2_continuation':
        return find_c2_continuations(candles, references, interval=interval, settings=settings,
                                    tick_size=tick_size, start=start, end=end)
    step = interval_ms(interval)
    profiles = complete_profiles(candles, step, end)
    ref_profiles = {symbol: complete_profiles(bars, step, end) for symbol, bars in references.items()}
    times = [b.time for b in candles]
    stats: Counter = Counter(complete_4h_profiles=len(profiles))
    signals = []
    for stamp, c2 in sorted(profiles.items()):
        known = stamp + FOUR_HOURS
        # A profile formed in warmup can still confirm an entry inside the
        # requested window. Replay it from its close to retain invalidations.
        if known + FOUR_HOURS <= start or known >= end:
            continue
        c1 = profiles.get(stamp - FOUR_HOURS)
        if c1 is None:
            stats["missing_previous_4h"] += 1
            continue
        stats["eligible_4h_pairs"] += 1
        synchronized = all(c1.time in ref and c2.time in ref for ref in ref_profiles.values())
        if ref_profiles and synchronized:
            stats["synchronized_4h_pairs"] += 1
        swept_low, swept_high = c2.low < c1.low, c2.high > c1.high
        if swept_low == swept_high or not c1.low < c2.close < c1.high:
            stats["no_single_sweep_reclaim"] += 1
            continue
        long = swept_low
        direction = "long" if long else "short"
        if (c2.close <= c2.open if long else c2.close >= c2.open):
            stats["wrong_c2_body_direction"] += 1
            continue
        if settings.direction not in {"both", direction}:
            stats["direction_rejected"] += 1
            continue
        stats["sweep_reclaim_profiles"] += 1
        divergent, opposed = [], []
        missing = False
        for symbol, reference in ref_profiles.items():
            r1, r2 = reference.get(c1.time), reference.get(c2.time)
            if r1 is None or r2 is None:
                missing = True
                continue
            if (r2.low >= r1.low if long else r2.high <= r1.high):
                divergent.append(symbol)
            if (r2.close < r2.open if long else r2.close > r2.open):
                opposed.append(symbol)
        if settings.require_cross_asset and (missing or not divergent):
            stats["cross_asset_rejected"] += 1
            stats["cross_asset_data_missing" if missing else "no_cross_asset_divergence"] += 1
            continue
        stop = c2.low - tick_size * settings.stop_buffer_ticks if long else c2.high + tick_size * settings.stop_buffer_ticks
        target = c1.high if long else c1.low
        expiry = known + FOUR_HOURS
        first = bisect_left(times, known)
        triggered = False
        for index in range(first, min(len(candles), first + settings.confirmation_bars)):
            bar = candles[index]
            confirmed = bar.time + step
            if confirmed >= expiry or confirmed > end:
                break
            if bar.time != known + (index - first) * step:
                stats["confirmation_data_gap"] += 1
                break
            # Once either boundary trades, the original opportunity is gone.
            invalid = (bar.low <= stop or bar.high >= target) if long else (bar.high >= stop or bar.low <= target)
            if invalid:
                stats["invalidated_before_confirmation"] += 1
                break
            if index < first + 2:
                continue
            a, b, c = candles[index - 2:index + 1]
            body = abs(b.close - b.open) / (b.high - b.low) if b.high > b.low else 0.0
            gap = c.low > a.high if long else c.high < a.low
            displacement = b.close > b.open if long else b.close < b.open
            if not gap or not displacement or body < settings.minimum_body_fraction:
                continue
            local = datetime.fromtimestamp(confirmed / 1000, NY)
            minute = local.hour * 60 + local.minute
            if settings.ny_morning_only and not 570 <= minute < 660:
                stats["outside_ny_morning"] += 1
                continue
            if confirmed < start:
                # The first qualifying entry already happened. Do not reuse
                # the same profile to cherry-pick a later in-window entry.
                stats["entry_before_window"] += 1
                break
            bottom, top = (a.high, c.low) if long else (c.high, a.low)
            evidence = GxtEvidence(
                direction=direction, profile="bullish_sweep_reclaim" if long else "bearish_sweep_reclaim",
                context_start=c1.time, context_end=known, confirmed_at=confirmed,
                signal_bar_time=bar.time, swept_level=c1.low if long else c1.high,
                stop_price=stop, target_price=target, gap_bottom=bottom, gap_top=top,
                reference_symbols=divergent, opposed_close_symbols=opposed,
                entry_session_ny=local.isoformat(),
                steps=[
                    "Two adjacent, complete 4H candles on the 18:00 New York session grid.",
                    f"C2 swept only the prior {'low' if long else 'high'}, closed back inside C1 and closed {'up' if long else 'down'}.",
                    "Matched 4H sweep divergence: " + (", ".join(divergent) or "not required"),
                    "After C2 closed, a three-candle displacement gap confirmed on the entry timeframe.",
                    "Enter the next open; stop beyond C2, target the opposite C1 extreme. Minimum reward/risk checked at entry.",
                ],
            )
            signals.append(GxtSignal(bisect_left(times, stamp), index, expiry, evidence))
            triggered = True
            stats["confirmed_signals"] += 1
            break  # One opportunity per C2, never cherry-pick a later entry.
        if not triggered:
            stats["profiles_without_entry"] += 1
    return signals, dict(stats)
