"""Time conversion helpers.

Internally the whole system uses **Unix milliseconds (UTC)** for candle
timestamps.  ``datetime`` objects only appear at the edges (provider clients
and query parsing) and are always timezone aware.
"""

from __future__ import annotations

from datetime import datetime, timezone
from zoneinfo import ZoneInfo

UTC = timezone.utc


def now_ms() -> int:
    return int(datetime.now(tz=UTC).timestamp() * 1000)


def to_ms(value: datetime) -> int:
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return int(value.timestamp() * 1000)


def from_ms(value: int) -> datetime:
    return datetime.fromtimestamp(value / 1000, tz=UTC)


def parse_time_param(value: str | int | float | datetime) -> int:
    """Parse a ``from``/``to`` query parameter into Unix milliseconds.

    Accepts milliseconds, seconds, and ISO-8601 strings so that the endpoint is
    forgiving about what the charting layer sends.
    """

    if isinstance(value, datetime):
        return to_ms(value)
    if isinstance(value, (int, float)):
        return _numeric_to_ms(float(value))
    text = str(value).strip()
    if not text:
        raise ValueError("Empty timestamp")
    try:
        return _numeric_to_ms(float(text))
    except ValueError:
        pass
    iso = text.replace("Z", "+00:00")
    parsed = datetime.fromisoformat(iso)
    return to_ms(parsed)


def _numeric_to_ms(value: float) -> float | int:
    # Anything below this threshold cannot plausibly be milliseconds (it would
    # be 1970), so treat it as seconds.  1e11 ms == 1973-03-03.
    if abs(value) < 1e11:
        return int(round(value * 1000))
    return int(round(value))


def local_day_start_ms(timestamp_ms: int, tz_name: str) -> int:
    """Return the UTC millisecond value of local midnight for ``timestamp_ms``."""

    tz = ZoneInfo(tz_name)
    local = datetime.fromtimestamp(timestamp_ms / 1000, tz=tz)
    midnight = local.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp() * 1000)


def format_ms(timestamp_ms: int) -> str:
    return from_ms(timestamp_ms).isoformat().replace("+00:00", "Z")
