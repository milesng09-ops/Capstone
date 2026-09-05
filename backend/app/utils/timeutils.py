"""Time conversion helpers.

Internally the whole system uses **Unix milliseconds (UTC)** for candle
timestamps.  ``datetime`` objects only appear at the edges (provider clients
and query parsing) and are always timezone aware.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
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


def format_ms(timestamp_ms: int) -> str:
    return from_ms(timestamp_ms).isoformat().replace("+00:00", "Z")


def session_day_start_ms(timestamp_ms: int, tz_name: str, open_hour: int) -> int:
    """UTC milliseconds of the session open at or before ``timestamp_ms``.

    A futures day is not a calendar day: it opens the previous evening, so an
    instant at 09:00 belongs to the session that began at ``open_hour`` the
    day before.  The boundary is a *local wall-clock* time, which is the whole
    reason this cannot be a constant offset from the epoch -- it moves against
    UTC twice a year, and a fixed offset silently drifts an hour for four
    months of every year.

    ``open_hour`` is never near a daylight-saving transition (those happen at
    02:00 local), so the local time always exists exactly once and needs no
    fold handling.
    """

    tz = ZoneInfo(tz_name)
    local = datetime.fromtimestamp(timestamp_ms / 1000, tz=tz)
    opening = local.replace(hour=open_hour, minute=0, second=0, microsecond=0)
    if local < opening:
        opening -= timedelta(days=1)
    return int(opening.timestamp() * 1000)
