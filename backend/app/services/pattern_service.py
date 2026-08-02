"""Deterministic historical pattern comparison.

**There is no machine learning here.**  Nothing is trained, fitted or learned.
The comparison is a fixed, auditable transformation: candles become a feature
vector by explicit arithmetic, and windows are ranked by cosine similarity.
Running the same query twice always produces the same ranking.

Feature blocks (all computed *only* from candles inside the window, so no
future information can leak in):

============================  ==========================================
Block                         Definition
============================  ==========================================
``normalised_close``          close / first close - 1
``returns``                   bar-over-bar percentage change
``body``                      (close - open) / (high - low)
``upper_wick``                (high - max(open, close)) / (high - low)
``lower_wick``                (min(open, close) - low) / (high - low)
``volatility``                rolling stdev of returns / window mean
``volume``                    log1p(volume) / window mean, when available
============================  ==========================================

Each block is standardised within its own window before being weighted and
concatenated, so no single block dominates the similarity purely because of
its units.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field

import numpy as np

from app.models.domain import Candle

logger = logging.getLogger(__name__)

EPSILON = 1e-12

#: Relative influence of each block on the final similarity score.
BLOCK_WEIGHTS: dict[str, float] = {
    "normalised_close": 1.0,
    "returns": 0.9,
    "body": 0.6,
    "upper_wick": 0.4,
    "lower_wick": 0.4,
    "volatility": 0.5,
    "volume": 0.3,
}

VOLATILITY_WINDOW = 5

#: Candidate windows scored per batch. Bounds peak memory during the search.
_CHUNK_SIZE = 4_096


class PatternError(ValueError):
    """Raised when a selection cannot be turned into a comparable pattern."""


@dataclass
class PatternWindow:
    """One candidate window and its score against the query pattern."""

    symbol: str
    interval: str
    start_index: int
    end_index: int
    start_time: int
    end_time: int
    similarity: float
    euclidean_distance: float
    entry_price: float
    normalized_series: list[float] = field(default_factory=list)


@dataclass
class PatternQuery:
    """The selected setup, reduced to a comparable feature vector."""

    symbol: str
    interval: str
    start_time: int
    end_time: int
    length: int
    vector: np.ndarray
    normalized_series: list[float]
    resampled: bool = False


# --------------------------------------------------------------------------
# Feature construction
# --------------------------------------------------------------------------
def candles_to_arrays(candles: list[Candle]) -> dict[str, np.ndarray]:
    return {
        "time": np.array([candle.time for candle in candles], dtype=np.int64),
        "open": np.array([candle.open for candle in candles], dtype=np.float64),
        "high": np.array([candle.high for candle in candles], dtype=np.float64),
        "low": np.array([candle.low for candle in candles], dtype=np.float64),
        "close": np.array([candle.close for candle in candles], dtype=np.float64),
        "volume": np.array([candle.volume for candle in candles], dtype=np.float64),
    }


def _standardise(block: np.ndarray) -> np.ndarray:
    """Zero-mean, unit-variance along the last axis; constant blocks become 0."""

    mean = block.mean(axis=-1, keepdims=True)
    centred = block - mean
    scale = np.sqrt((centred**2).mean(axis=-1, keepdims=True))
    return np.divide(centred, scale, out=np.zeros_like(centred), where=scale > EPSILON)


def _rolling_volatility(returns: np.ndarray, window: int) -> np.ndarray:
    """Trailing standard deviation of returns, padded at the start."""

    length = returns.shape[-1]
    effective = min(window, max(2, length))
    output = np.empty_like(returns)
    for index in range(length):
        low = max(0, index - effective + 1)
        segment = returns[..., low : index + 1]
        output[..., index] = segment.std(axis=-1)
    return output


def build_feature_matrix(
    opens: np.ndarray,
    highs: np.ndarray,
    lows: np.ndarray,
    closes: np.ndarray,
    volumes: np.ndarray | None,
) -> np.ndarray:
    """Build weighted feature vectors for one or many windows.

    Accepts either 1-D arrays (a single window) or 2-D arrays shaped
    ``(n_windows, window_length)``.  Returns ``(n_windows, n_features)``.
    """

    single = opens.ndim == 1
    if single:
        opens = opens[None, :]
        highs = highs[None, :]
        lows = lows[None, :]
        closes = closes[None, :]
        if volumes is not None:
            volumes = volumes[None, :]

    first_close = closes[:, :1]
    normalised_close = np.divide(
        closes,
        first_close,
        out=np.ones_like(closes),
        where=np.abs(first_close) > EPSILON,
    ) - 1.0

    previous = np.concatenate([closes[:, :1], closes[:, :-1]], axis=1)
    returns = np.divide(
        closes - previous,
        previous,
        out=np.zeros_like(closes),
        where=np.abs(previous) > EPSILON,
    )

    bar_range = highs - lows
    safe_range = np.where(bar_range > EPSILON, bar_range, np.nan)

    body = np.nan_to_num((closes - opens) / safe_range, nan=0.0)
    upper_wick = np.nan_to_num((highs - np.maximum(opens, closes)) / safe_range, nan=0.0)
    lower_wick = np.nan_to_num((np.minimum(opens, closes) - lows) / safe_range, nan=0.0)

    volatility = _rolling_volatility(returns, VOLATILITY_WINDOW)
    volatility_mean = volatility.mean(axis=1, keepdims=True)
    volatility = np.divide(
        volatility,
        volatility_mean,
        out=np.ones_like(volatility),
        where=volatility_mean > EPSILON,
    )

    blocks = [
        ("normalised_close", normalised_close),
        ("returns", returns),
        ("body", body),
        ("upper_wick", upper_wick),
        ("lower_wick", lower_wick),
        ("volatility", volatility),
    ]

    if volumes is not None and np.any(volumes > 0):
        log_volume = np.log1p(np.maximum(volumes, 0.0))
        volume_mean = log_volume.mean(axis=1, keepdims=True)
        normalised_volume = np.divide(
            log_volume,
            volume_mean,
            out=np.ones_like(log_volume),
            where=volume_mean > EPSILON,
        )
        blocks.append(("volume", normalised_volume))

    parts = [_standardise(values) * BLOCK_WEIGHTS[name] for name, values in blocks]
    matrix = np.concatenate(parts, axis=1)
    return matrix


def resample_series(values: np.ndarray, target_length: int) -> np.ndarray:
    """Linear resampling so windows of different lengths stay comparable."""

    source_length = values.shape[-1]
    if source_length == target_length:
        return values
    if source_length < 2:
        raise PatternError("A pattern needs at least two candles")
    source_positions = np.linspace(0.0, 1.0, source_length)
    target_positions = np.linspace(0.0, 1.0, target_length)
    return np.interp(target_positions, source_positions, values)


def build_query(
    candles: list[Candle],
    interval: str,
    pattern_length: int | None = None,
    *,
    min_length: int = 5,
    max_length: int = 400,
) -> PatternQuery:
    """Turn a user selection into a comparable pattern."""

    if len(candles) < min_length:
        raise PatternError(
            f"The selected period contains {len(candles)} candles. "
            f"At least {min_length} are required - widen the selection or use a smaller interval."
        )

    target_length = pattern_length or len(candles)
    if target_length < min_length or target_length > max_length:
        raise PatternError(
            f"Pattern length must be between {min_length} and {max_length} candles."
        )

    arrays = candles_to_arrays(candles)
    resampled = target_length != len(candles)
    if resampled:
        opens = resample_series(arrays["open"], target_length)
        highs = resample_series(arrays["high"], target_length)
        lows = resample_series(arrays["low"], target_length)
        closes = resample_series(arrays["close"], target_length)
        volumes = resample_series(arrays["volume"], target_length)
    else:
        opens, highs, lows = arrays["open"], arrays["high"], arrays["low"]
        closes, volumes = arrays["close"], arrays["volume"]

    vector = build_feature_matrix(opens, highs, lows, closes, volumes)[0]
    normalised = (closes / closes[0] - 1.0) * 100.0

    return PatternQuery(
        symbol=candles[0].symbol,
        interval=interval,
        start_time=candles[0].time,
        end_time=candles[-1].time,
        length=target_length,
        vector=vector,
        normalized_series=[round(float(value), 4) for value in normalised],
        resampled=resampled,
    )


# --------------------------------------------------------------------------
# Sliding-window search
# --------------------------------------------------------------------------
def _sliding_view(values: np.ndarray, window: int) -> np.ndarray:
    return np.lib.stride_tricks.sliding_window_view(values, window)


def find_similar_windows(
    query: PatternQuery,
    candles: list[Candle],
    interval: str,
    *,
    exclude_ranges: list[tuple[int, int]],
    minimum_similarity: float,
    maximum_matches: int,
    minimum_separation_bars: int | None = None,
    required_future_bars: int = 0,
    max_candidate_windows: int = 250_000,
) -> list[PatternWindow]:
    """Rank historical windows by similarity to ``query``.

    Leakage controls applied here:

    * candidate windows overlapping ``exclude_ranges`` (the selection itself)
      are discarded;
    * a window is only accepted when ``required_future_bars`` candles exist
      after it, so the trade simulation never runs off the end of the data;
    * accepted matches are separated by at least ``minimum_separation_bars``,
      which stops one strong pattern being reported as dozens of near-identical
      shifted copies;
    * features are computed strictly from candles inside the window.
    """

    window_length = query.length
    total = len(candles)
    if total < window_length + required_future_bars:
        return []

    arrays = candles_to_arrays(candles)
    window_count = total - window_length + 1
    if window_count <= 0:
        return []
    if window_count > max_candidate_windows:
        raise PatternError(
            f"The lookback range produces {window_count:,} candidate windows, "
            f"above the {max_candidate_windows:,} limit. Narrow the lookback range."
        )

    views = {
        key: _sliding_view(arrays[key], window_length)
        for key in ("open", "high", "low", "close", "volume")
    }

    # Feature matrices are dense, so candidates are scored in chunks to keep
    # peak memory proportional to the chunk size rather than the lookback.
    similarities = np.zeros(window_count, dtype=np.float64)
    distances = np.zeros(window_count, dtype=np.float64)
    query_vector = query.vector
    query_norm = float(np.linalg.norm(query_vector))

    for chunk_start in range(0, window_count, _CHUNK_SIZE):
        chunk_end = min(chunk_start + _CHUNK_SIZE, window_count)
        matrix = build_feature_matrix(
            views["open"][chunk_start:chunk_end],
            views["high"][chunk_start:chunk_end],
            views["low"][chunk_start:chunk_end],
            views["close"][chunk_start:chunk_end],
            views["volume"][chunk_start:chunk_end],
        )

        vector = query_vector
        if matrix.shape[1] != vector.shape[0]:
            # Happens when the query had volume data and the candidates do not
            # (or vice versa). Compare the shared prefix of blocks.
            shared = min(matrix.shape[1], vector.shape[0])
            matrix = matrix[:, :shared]
            vector = vector[:shared]
            norm = float(np.linalg.norm(vector))
        else:
            norm = query_norm

        candidate_norms = np.linalg.norm(matrix, axis=1)
        denominator = candidate_norms * norm
        similarities[chunk_start:chunk_end] = np.divide(
            matrix @ vector,
            denominator,
            out=np.zeros(matrix.shape[0]),
            where=denominator > EPSILON,
        )
        distances[chunk_start:chunk_end] = np.linalg.norm(
            matrix - vector, axis=1
        ) / max(np.sqrt(vector.shape[0]), EPSILON)

    times = arrays["time"]
    window_starts = times[: window_count]
    window_ends = times[window_length - 1 : window_length - 1 + window_count]

    # ---- eligibility mask -------------------------------------------------
    eligible = np.ones(window_count, dtype=bool)
    if required_future_bars > 0:
        last_usable = window_count - required_future_bars
        if last_usable <= 0:
            return []
        eligible[last_usable:] = False

    for range_start, range_end in exclude_ranges:
        overlapping = (window_starts <= range_end) & (window_ends >= range_start)
        eligible &= ~overlapping

    eligible &= similarities >= minimum_similarity
    if not eligible.any():
        return []

    separation = (
        minimum_separation_bars
        if minimum_separation_bars is not None
        else max(1, window_length // 2)
    )

    # ---- greedy, non-overlapping selection --------------------------------
    order = np.argsort(-similarities)
    selected: list[int] = []
    for index in order:
        if not eligible[index]:
            continue
        if len(selected) >= maximum_matches:
            break
        if any(abs(int(index) - other) < separation for other in selected):
            continue
        selected.append(int(index))

    selected.sort(key=lambda position: -similarities[position])

    results: list[PatternWindow] = []
    for rank, index in enumerate(selected):
        window_closes = arrays["close"][index : index + window_length]
        normalised = (window_closes / window_closes[0] - 1.0) * 100.0
        results.append(
            PatternWindow(
                symbol=candles[0].symbol,
                interval=interval,
                start_index=index,
                end_index=index + window_length - 1,
                start_time=int(window_starts[index]),
                end_time=int(window_ends[index]),
                similarity=float(similarities[index]),
                euclidean_distance=float(distances[index]),
                entry_price=float(window_closes[-1]),
                normalized_series=[round(float(value), 4) for value in normalised],
            )
        )
        logger.debug("match rank=%s similarity=%.4f", rank, results[-1].similarity)

    return results
