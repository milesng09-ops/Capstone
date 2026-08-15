"""ICT analysis orchestration.

Fetches the primary series plus every correlated reference series through the
same cached :class:`~app.services.candle_service.CandleService` the charts
use, runs the deterministic detectors over them, and trims the result to
something a browser can actually render.

Reference symbols are fetched over the **same window and interval** as the
primary so that SMT comparison lines up bar for bar.  A reference that returns
no overlapping candles is reported as a warning rather than silently dropped,
because a missing comparison is the difference between "no divergence" and
"could not check".
"""

from __future__ import annotations

import logging
from typing import TypeVar

import anyio

from app.analysis.fair_value_gap import FairValueGap, find_fair_value_gaps
from app.analysis.smt import SmtDivergence, find_smt_divergences
from app.analysis.structure import SwingPoint, find_swing_points
from app.config import get_settings
from app.models.domain import Candle
from app.models.schemas import (
    FairValueGapOut,
    IctAnalysisResponse,
    SmtDivergenceOut,
    SwingPointOut,
)
from app.providers.instruments import get_instrument
from app.services.candle_service import CandleService, get_candle_service

logger = logging.getLogger(__name__)

_ItemT = TypeVar("_ItemT")


class IctService:
    def __init__(self, candle_service: CandleService | None = None) -> None:
        self._candles = candle_service or get_candle_service()

    async def analyse(
        self,
        symbol: str,
        interval: str,
        start: int,
        end: int,
        *,
        reference_symbols: list[str] | None = None,
        swing_strength: int | None = None,
        min_gap_percent: float = 0.0,
        include_filled_gaps: bool = True,
        include_invalid_smt: bool = False,
    ) -> IctAnalysisResponse:
        settings = get_settings()
        primary = get_instrument(symbol).symbol
        strength = swing_strength or settings.default_swing_strength
        warnings: list[str] = []

        references = self._resolve_references(primary, reference_symbols, settings, warnings)

        primary_result = await self._candles.get_series_for_analysis(
            primary, interval, start, end
        )
        primary_candles = primary_result.bars

        if len(primary_candles) < 2 * strength + 1:
            warnings.append(
                f"{primary}: only {len(primary_candles)} candles in this window, which is "
                f"too few to confirm a swing point at strength {strength}."
            )
            return IctAnalysisResponse(
                symbol=primary,
                interval=interval,
                from_time=start,
                to_time=end,
                provider=primary_result.provider,
                bars_analysed=len(primary_candles),
                swing_strength=strength,
                reference_symbols=references,
                warnings=warnings,
            )

        primary_swings, primary_gaps = await anyio.to_thread.run_sync(
            _detect, primary_candles, strength, min_gap_percent, include_filled_gaps
        )

        divergences: list[SmtDivergence] = []
        for reference in references:
            reference_result = await self._candles.get_series_for_analysis(
                reference, interval, start, end
            )
            reference_candles = reference_result.bars
            if len(reference_candles) < 2 * strength + 1:
                warnings.append(
                    f"{reference}: not enough candles in this window to compare against "
                    f"{primary}, so SMT divergences against it were not checked."
                )
                continue

            overlap = _shared_bar_count(primary_candles, reference_candles)
            if overlap == 0:
                warnings.append(
                    f"{reference}: no bars share a timestamp with {primary} on the "
                    f"{interval} interval, so the two charts could not be compared."
                )
                continue

            # SMT divergence only means anything when both series describe the
            # same market reality. Comparing synthetic demo bars against real
            # vendor prices produces divergences that are pure artefact, so the
            # mismatch is surfaced rather than silently charted.
            if reference_result.provider != primary_result.provider:
                warnings.append(
                    f"{reference} came from '{reference_result.provider}' but {primary} came "
                    f"from '{primary_result.provider}'. SMT divergence compares two markets "
                    "bar for bar, so a mixed-source comparison is not meaningful -- treat "
                    "these divergences as unreliable."
                )

            found = await anyio.to_thread.run_sync(
                _detect_smt,
                primary_candles,
                primary_swings,
                primary_gaps,
                reference_candles,
                strength,
                min_gap_percent,
                include_invalid_smt,
            )
            divergences.extend(found)

        divergences.sort(key=lambda item: item.end_time)

        swings_out, truncated = _trim(primary_swings, settings.max_swing_points)
        if truncated:
            warnings.append(
                f"Showing the {settings.max_swing_points} most recent swing points of "
                f"{len(primary_swings)}. Narrow the range or raise the swing strength."
            )

        gaps_out, truncated = _trim(primary_gaps, settings.max_fair_value_gaps)
        if truncated:
            warnings.append(
                f"Showing the {settings.max_fair_value_gaps} most recent fair value gaps "
                f"of {len(primary_gaps)}. Raise the minimum gap size to see fewer."
            )

        smt_out, truncated = _trim(divergences, settings.max_smt_divergences)
        if truncated:
            warnings.append(
                f"Showing the {settings.max_smt_divergences} most recent SMT divergences "
                f"of {len(divergences)}."
            )

        return IctAnalysisResponse(
            symbol=primary,
            interval=interval,
            from_time=start,
            to_time=end,
            provider=primary_result.provider,
            bars_analysed=len(primary_candles),
            swing_strength=strength,
            reference_symbols=references,
            swing_points=[_swing_out(point) for point in swings_out],
            fair_value_gaps=[_gap_out(gap) for gap in gaps_out],
            smt_divergences=[_smt_out(item) for item in smt_out],
            warnings=warnings,
        )

    # ------------------------------------------------------------------
    @staticmethod
    def _resolve_references(
        primary: str,
        requested: list[str] | None,
        settings,
        warnings: list[str],
    ) -> list[str]:
        """Validate reference symbols, dropping the primary and duplicates."""

        if not requested:
            return []

        resolved: list[str] = []
        for candidate in requested:
            try:
                name = get_instrument(candidate).symbol
            except ValueError as exc:
                warnings.append(str(exc))
                continue
            if name == primary or name in resolved:
                continue
            resolved.append(name)

        # The primary occupies one slot of the workspace budget.
        limit = max(0, settings.max_symbols_per_workspace - 1)
        if len(resolved) > limit:
            warnings.append(
                f"A workspace compares at most {settings.max_symbols_per_workspace} symbols; "
                f"using {', '.join(resolved[:limit])}."
            )
            resolved = resolved[:limit]
        return resolved


# --------------------------------------------------------------------------
# Thread-offloaded detector wrappers
# --------------------------------------------------------------------------
def _detect(
    candles: list[Candle],
    strength: int,
    min_gap_percent: float,
    include_filled_gaps: bool,
) -> tuple[list[SwingPoint], list[FairValueGap]]:
    return (
        find_swing_points(candles, strength=strength),
        find_fair_value_gaps(
            candles,
            min_size_percent=min_gap_percent,
            include_filled=include_filled_gaps,
        ),
    )


def _detect_smt(
    primary_candles: list[Candle],
    primary_swings: list[SwingPoint],
    primary_gaps: list[FairValueGap],
    reference_candles: list[Candle],
    strength: int,
    min_gap_percent: float,
    include_invalid: bool,
) -> list[SmtDivergence]:
    reference_swings = find_swing_points(reference_candles, strength=strength)
    # Validity checks need the reference chart's own gaps, so they are always
    # computed with filled gaps included: a gap that is filled today may still
    # have been the valid anchor months ago.
    reference_gaps = find_fair_value_gaps(
        reference_candles, min_size_percent=min_gap_percent, include_filled=True
    )
    return find_smt_divergences(
        primary_candles,
        primary_swings,
        reference_candles,
        reference_swings,
        primary_gaps=primary_gaps,
        reference_gaps=reference_gaps,
        include_invalid=include_invalid,
    )


def _shared_bar_count(left: list[Candle], right: list[Candle]) -> int:
    right_times = {candle.time for candle in right}
    return sum(1 for candle in left if candle.time in right_times)


def _trim(items: list[_ItemT], limit: int) -> tuple[list[_ItemT], bool]:
    """Keep the most recent ``limit`` items; report whether anything was cut."""

    if len(items) <= limit:
        return items, False
    return items[-limit:], True


# --------------------------------------------------------------------------
# Mapping to API schemas
# --------------------------------------------------------------------------
def _swing_out(point: SwingPoint) -> SwingPointOut:
    return SwingPointOut(
        symbol=point.symbol,
        kind=point.kind,
        time=point.time,
        price=point.price,
        confirmed_time=point.confirmed_time,
        strength=point.strength,
    )


def _gap_out(gap: FairValueGap) -> FairValueGapOut:
    return FairValueGapOut(
        symbol=gap.symbol,
        direction=gap.direction,
        time=gap.time,
        start_time=gap.start_time,
        end_time=gap.end_time,
        bottom=gap.bottom,
        top=gap.top,
        midpoint=gap.midpoint,
        size=gap.size,
        size_percent=round(gap.size_percent, 6),
        mitigated=gap.mitigated,
        mitigated_time=gap.mitigated_time,
        filled=gap.filled,
        filled_time=gap.filled_time,
        penetration=round(gap.penetration, 6),
    )


def _smt_out(item: SmtDivergence) -> SmtDivergenceOut:
    return SmtDivergenceOut(
        kind=item.kind,
        bias=item.bias,
        primary_symbol=item.primary_symbol,
        reference_symbol=item.reference_symbol,
        start_time=item.start_time,
        end_time=item.end_time,
        primary_start_price=item.primary_start_price,
        primary_end_price=item.primary_end_price,
        reference_start_price=item.reference_start_price,
        reference_end_price=item.reference_end_price,
        leading_symbol=item.leading_symbol,
        lagging_symbol=item.lagging_symbol,
        validity=item.validity,
        valid=item.valid,
        confirmed_time=item.confirmed_time,
        inside_fair_value_gap=item.inside_fair_value_gap,
        fair_value_gap_time=item.fair_value_gap_time,
        strength=round(item.strength, 6),
        separation_bars=item.separation_bars,
    )


_service: IctService | None = None


def get_ict_service() -> IctService:
    global _service
    if _service is None:
        _service = IctService()
    return _service
