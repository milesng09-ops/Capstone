"""Deterministic demo-data generation and loading.

Demo mode has to be a first-class experience: the whole product (charts,
selection, similarity search, backtesting) must work with no API keys at all.
That means the bundled dataset needs to be *realistic* -- recognisable trends,
ranges, volatility regimes and session gaps -- and above all **stable**.

Determinism comes from three rules:

1. Every symbol has a fixed integer seed.
2. Randomness uses ``numpy.random.default_rng`` (PCG64), whose stream is
   guaranteed reproducible across NumPy versions.
3. The generated dataset is written to ``data/demo`` once and reused; it is
   never regenerated per request or per page load.

The on-disk format is column-oriented to keep the files small.  It is expanded
into the standard normalised candle schema on load.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np

from app.models.domain import Candle
from app.providers.instruments import CANONICAL_INSTRUMENTS

logger = logging.getLogger(__name__)

CHICAGO = ZoneInfo("America/Chicago")
UTC = timezone.utc

FIVE_MIN_MS = 5 * 60 * 1000
DEMO_LABEL = "Demo data - not actual market prices."
DEMO_SPAN_DAYS = 180

#: Default end of the generated series.  Pinned so a fresh checkout produces
#: byte-identical files; override with ``--end`` in the regeneration script.
DEFAULT_END_DATE = "2026-08-01"

SYMBOL_SEEDS: dict[str, int] = {"ES": 20260801, "NQ": 20260802, "YM": 20260803}
MARKET_SEED = 777_000_001

#: Starting prices roughly consistent with the instruments they represent.
SYMBOL_BASE_PRICE: dict[str, float] = {"ES": 6400.00, "NQ": 23100.00, "YM": 47500.0}
#: Sensitivity of each symbol to the shared market factor.
SYMBOL_BETA: dict[str, float] = {"ES": 1.0, "NQ": 1.35, "YM": 0.82}
#: Idiosyncratic volatility as a fraction of the market factor's volatility.
SYMBOL_IDIO: dict[str, float] = {"ES": 0.25, "NQ": 0.45, "YM": 0.30}
SYMBOL_BASE_VOLUME: dict[str, float] = {"ES": 5200.0, "NQ": 2400.0, "YM": 900.0}


@dataclass(frozen=True)
class Regime:
    """One stretch of market character."""

    name: str
    days: int
    #: Annualised-ish drift expressed per trading day, in percent.
    daily_drift_pct: float
    #: Multiplier applied to the baseline volatility.
    vol_multiplier: float
    #: Multiplier applied to overnight session gaps.
    gap_multiplier: float
    volume_multiplier: float


#: A fixed cycle that guarantees the dataset contains every pattern type the
#: product is meant to help analyse.
REGIME_CYCLE: list[Regime] = [
    Regime("steady_uptrend", 18, 0.32, 0.85, 0.8, 1.00),
    Regime("tight_range", 14, 0.01, 0.55, 0.5, 0.78),
    Regime("sharp_selloff", 9, -0.95, 2.10, 2.4, 1.65),
    Regime("volatile_recovery", 13, 0.55, 1.55, 1.6, 1.35),
    Regime("choppy_high_vol", 12, -0.05, 1.80, 1.3, 1.25),
    Regime("grind_higher", 20, 0.24, 0.70, 0.6, 0.88),
    Regime("distribution_top", 12, -0.10, 1.05, 1.0, 1.10),
    Regime("gap_down_trend", 10, -0.55, 1.45, 2.8, 1.40),
    Regime("range_expansion", 11, 0.14, 1.25, 1.1, 1.05),
]


# --------------------------------------------------------------------------
# Session calendar
# --------------------------------------------------------------------------
def _is_trading_minute(local: datetime) -> bool:
    """CME equity-index session: Sun 17:00 CT to Fri 16:00 CT, 16:00-17:00 halt."""

    weekday = local.weekday()  # Monday = 0
    if weekday == 5:  # Saturday
        return False
    if weekday == 6:  # Sunday, only the evening reopen
        return local.hour >= 17
    if weekday == 4 and local.hour >= 16:  # Friday close
        return False
    if local.hour == 16:  # daily maintenance window
        return False
    return True


def _session_timestamps(start: datetime, end: datetime) -> list[int]:
    """Every 5-minute open timestamp (ms, UTC) inside the trading calendar."""

    timestamps: list[int] = []
    cursor = start
    step = timedelta(minutes=5)
    while cursor < end:
        if _is_trading_minute(cursor.astimezone(CHICAGO)):
            timestamps.append(int(cursor.timestamp() * 1000))
        cursor += step
    return timestamps


def _intraday_volatility_factor(local: datetime) -> float:
    """U-shaped intraday volatility, peaking around the RTH open."""

    minutes = local.hour * 60 + local.minute
    rth_open = 8 * 60 + 30
    rth_close = 15 * 60
    if minutes < rth_open or minutes > rth_close:
        # Overnight / Globex: quieter, with a small European-open bump.
        return 0.45 if not (60 <= minutes <= 180) else 0.62
    span = rth_close - rth_open
    position = (minutes - rth_open) / span
    # High at the open, dipping midday, rising into the close.
    return 0.85 + 1.05 * np.exp(-position * 6.0) + 0.55 * np.exp(-(1 - position) * 7.0)


def _intraday_volume_factor(local: datetime) -> float:
    minutes = local.hour * 60 + local.minute
    rth_open = 8 * 60 + 30
    rth_close = 15 * 60
    if minutes < rth_open or minutes > rth_close:
        return 0.18 if not (60 <= minutes <= 180) else 0.30
    span = rth_close - rth_open
    position = (minutes - rth_open) / span
    return 0.55 + 1.6 * np.exp(-position * 5.0) + 1.1 * np.exp(-(1 - position) * 6.0)


def _regime_for_day(day_index: int) -> Regime:
    cycle_length = sum(regime.days for regime in REGIME_CYCLE)
    position = day_index % cycle_length
    for regime in REGIME_CYCLE:
        if position < regime.days:
            return regime
        position -= regime.days
    return REGIME_CYCLE[-1]  # pragma: no cover - unreachable


# --------------------------------------------------------------------------
# Generation
# --------------------------------------------------------------------------
def _build_market_factor(timestamps: list[int]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return per-bar (drift, volatility, gap) series shared by all symbols.

    Sharing one factor is what makes ES/NQ/YM move together, which in turn
    makes multi-chart comparison meaningful.
    """

    count = len(timestamps)
    drift = np.zeros(count)
    volatility = np.zeros(count)
    gaps = np.zeros(count)

    rng = np.random.default_rng(MARKET_SEED)
    previous_day: int | None = None
    day_index = -1
    bars_today = 0

    # Baseline 5-minute volatility (fraction of price) before regime scaling.
    base_vol = 0.00055

    for index, timestamp in enumerate(timestamps):
        local = datetime.fromtimestamp(timestamp / 1000, tz=CHICAGO)
        # Session day rolls at the 17:00 CT reopen.
        session_day = (local - timedelta(hours=17)).toordinal()
        if session_day != previous_day:
            previous_day = session_day
            day_index += 1
            bars_today = 0
            regime = _regime_for_day(day_index)
            # Overnight gap on the first bar of each session.
            gaps[index] = rng.normal(
                regime.daily_drift_pct * 0.0018,
                0.0022 * regime.gap_multiplier,
            )
        bars_today += 1

        regime = _regime_for_day(day_index)
        # Spread the daily drift across ~276 five-minute bars.
        drift[index] = (regime.daily_drift_pct / 100.0) / 276.0
        volatility[index] = (
            base_vol
            * regime.vol_multiplier
            * _intraday_volatility_factor(local)
            # Slow-moving volatility-of-volatility so no two days look alike.
            * (1.0 + 0.25 * np.sin(index / 811.0) + 0.15 * np.sin(index / 173.0))
        )

    shocks = rng.standard_normal(count)
    # Mild autocorrelation produces visible trending stretches rather than noise.
    smoothed = np.empty(count)
    carry = 0.0
    for index in range(count):
        carry = 0.82 * carry + shocks[index]
        smoothed[index] = carry * 0.42
    market_returns = drift + volatility * smoothed + gaps

    return market_returns, volatility, gaps


def generate_symbol_bars(
    symbol: str,
    timestamps: list[int],
    market_returns: np.ndarray,
    market_volatility: np.ndarray,
) -> list[list[float]]:
    """Generate compact ``[time, open, high, low, close, volume]`` rows."""

    instrument = CANONICAL_INSTRUMENTS[symbol]
    rng = np.random.default_rng(SYMBOL_SEEDS[symbol])
    count = len(timestamps)

    beta = SYMBOL_BETA[symbol]
    idio_scale = SYMBOL_IDIO[symbol]
    idio = rng.standard_normal(count) * market_volatility * idio_scale
    returns = beta * market_returns + idio

    price = SYMBOL_BASE_PRICE[symbol]
    tick = instrument.tick_size
    precision = instrument.price_precision

    wick_up = np.abs(rng.standard_normal(count))
    wick_down = np.abs(rng.standard_normal(count))
    volume_noise = rng.lognormal(mean=0.0, sigma=0.35, size=count)
    base_volume = SYMBOL_BASE_VOLUME[symbol]

    rows: list[list[float]] = []
    previous_day: int | None = None
    day_index = -1

    for index, timestamp in enumerate(timestamps):
        local = datetime.fromtimestamp(timestamp / 1000, tz=CHICAGO)
        session_day = (local - timedelta(hours=17)).toordinal()
        if session_day != previous_day:
            previous_day = session_day
            day_index += 1
        regime = _regime_for_day(day_index)

        open_price = price
        close_price = open_price * (1.0 + returns[index])
        bar_range = max(abs(close_price - open_price), open_price * market_volatility[index])

        high = max(open_price, close_price) + wick_up[index] * bar_range * 0.55
        low = min(open_price, close_price) - wick_down[index] * bar_range * 0.55
        low = max(low, 0.15 * open_price)

        volume = (
            base_volume
            * _intraday_volume_factor(local)
            * regime.volume_multiplier
            * volume_noise[index]
            # Volume expands with the size of the move.
            * (1.0 + 4.0 * abs(returns[index]) / max(market_volatility[index], 1e-9) * 0.12)
        )

        rows.append(
            [
                timestamp,
                _round_tick(open_price, tick, precision),
                _round_tick(high, tick, precision),
                _round_tick(low, tick, precision),
                _round_tick(close_price, tick, precision),
                float(int(max(volume, 1.0))),
            ]
        )
        price = close_price

    return rows


def _round_tick(value: float, tick: float, precision: int) -> float:
    rounded = round(value / tick) * tick
    return round(rounded, precision)


def build_demo_dataset(
    symbol: str,
    end_date: str = DEFAULT_END_DATE,
    span_days: int = DEMO_SPAN_DAYS,
) -> dict:
    end = datetime.fromisoformat(end_date).replace(tzinfo=UTC)
    start = end - timedelta(days=span_days)
    timestamps = _session_timestamps(start, end)
    market_returns, market_volatility, _ = _build_market_factor(timestamps)
    rows = generate_symbol_bars(symbol, timestamps, market_returns, market_volatility)
    return {
        "symbol": symbol,
        "interval": "5m",
        "note": DEMO_LABEL,
        "seed": SYMBOL_SEEDS[symbol],
        "span_days": span_days,
        "end_date": end_date,
        "columns": ["time", "open", "high", "low", "close", "volume"],
        "bars": rows,
    }


def write_demo_dataset(directory: Path, symbol: str, **kwargs) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    payload = build_demo_dataset(symbol, **kwargs)
    path = directory / f"{symbol}_5m.json"
    path.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
    logger.info("Wrote %s demo bars to %s", len(payload["bars"]), path)
    return path


def load_demo_dataset(directory: Path, symbol: str) -> list[Candle]:
    """Load bundled demo candles, generating the file if it is missing."""

    path = directory / f"{symbol}_5m.json"
    if not path.exists():
        logger.warning("Demo dataset %s missing; generating it now", path)
        write_demo_dataset(directory, symbol)
    payload = json.loads(path.read_text(encoding="utf-8"))
    return [
        Candle(
            symbol=symbol,
            time=int(row[0]),
            open=float(row[1]),
            high=float(row[2]),
            low=float(row[3]),
            close=float(row[4]),
            volume=float(row[5]),
        )
        for row in payload["bars"]
    ]
