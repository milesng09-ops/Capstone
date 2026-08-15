"""Provenance guarding in the ICT service.

SMT divergence is a *comparison* between two markets. It only carries meaning
when both series describe the same reality, so a comparison that mixes
synthetic demo bars with real vendor prices has to announce itself rather than
be charted as though it were a signal.
"""

from __future__ import annotations

import pytest

from app.models.domain import BarsResult, Candle
from app.services.ict_service import IctService

HOUR_MS = 60 * 60 * 1000


def wave(symbol: str, highs: list[float]) -> list[Candle]:
    return [
        Candle(
            symbol=symbol,
            time=index * HOUR_MS,
            open=high - 0.5,
            high=high,
            low=high - 1.0,
            close=high - 0.5,
            volume=100.0,
        )
        for index, high in enumerate(highs)
    ]


class FakeCandleService:
    """Serves a fixed series per symbol, each tagged with its own provider."""

    def __init__(self, series: dict[str, tuple[list[Candle], str]]) -> None:
        self._series = series

    async def get_series_for_analysis(
        self, symbol: str, interval: str, start: int, end: int
    ) -> BarsResult:
        candles, provider = self._series[symbol]
        return BarsResult(
            symbol=symbol,
            interval=interval,
            provider=provider,
            cached=False,
            fallback_active=False,
            fallback_reason=None,
            quality="demo" if provider == "demo" else "delayed",
            bars=candles,
        )


SHAPE = [1, 2, 3, 4, 9, 4, 3, 2, 1, 2, 3, 4, 7, 4, 3, 2, 1, 2, 3, 4]


@pytest.mark.anyio
async def test_warns_when_the_two_charts_came_from_different_providers():
    service = IctService(
        FakeCandleService(
            {
                "NQ": (wave("NQ", SHAPE), "demo"),
                "ES": (wave("ES", SHAPE), "yahoo"),
            }
        )
    )

    result = await service.analyse(
        "NQ", "1h", 0, len(SHAPE) * HOUR_MS, reference_symbols=["ES"]
    )

    mixed = [w for w in result.warnings if "mixed-source" in w]
    assert mixed, f"expected a provenance warning, got {result.warnings}"
    assert "demo" in mixed[0] and "yahoo" in mixed[0]


@pytest.mark.anyio
async def test_stays_quiet_when_both_charts_share_a_provider():
    service = IctService(
        FakeCandleService(
            {
                "NQ": (wave("NQ", SHAPE), "demo"),
                "ES": (wave("ES", SHAPE), "demo"),
            }
        )
    )

    result = await service.analyse(
        "NQ", "1h", 0, len(SHAPE) * HOUR_MS, reference_symbols=["ES"]
    )

    assert not [w for w in result.warnings if "mixed-source" in w]
