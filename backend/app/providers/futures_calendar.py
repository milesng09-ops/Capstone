"""Quarterly futures roll calendar.

ES, NQ and YM all trade the March quarterly cycle: contracts expire on the
third Friday of March, June, September and December.  Open interest moves to
the next contract on the second Thursday of the expiry month -- eight days
before expiry -- so that is the boundary this module rolls on.

Splitting a request window into per-contract segments here, rather than inside
a provider, keeps the rule testable without a network call and keeps it
vendor neutral: the calendar deals in ``(year, month)`` pairs and leaves ticker
formatting to whichever provider needs it.

A stitched front-month series is *not* back-adjusted.  Each segment carries the
prices that contract actually traded at, so a chart shows a gap at every roll.
That is the honest choice for replay and backtesting -- a back-adjusted series
would show prices no one could ever have traded.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

#: CME month codes.  Only the quarterly four are ever produced here, but the
#: full table makes the mapping obvious to the next reader.
MONTH_CODES: dict[int, str] = {
    1: "F",
    2: "G",
    3: "H",
    4: "J",
    5: "K",
    6: "M",
    7: "N",
    8: "Q",
    9: "U",
    10: "V",
    11: "X",
    12: "Z",
}

#: The March quarterly cycle used by the equity index futures we support.
QUARTERLY_MONTHS: tuple[int, ...] = (3, 6, 9, 12)

#: Days before expiry that liquidity moves on.  Third Friday minus eight days
#: is the second Thursday.
ROLL_OFFSET_DAYS = 8

#: Exchange timezone for CME index futures.  Rolls happen at local midnight.
EXCHANGE_TIMEZONE = "America/Chicago"


def third_friday(year: int, month: int) -> date:
    """Expiry date for a quarterly equity index contract."""

    first = date(year, month, 1)
    # date.weekday(): Monday is 0, Friday is 4.
    first_friday = first + timedelta(days=(4 - first.weekday()) % 7)
    return first_friday + timedelta(days=14)


@dataclass(frozen=True)
class ContractMonth:
    """One quarterly delivery month."""

    year: int
    month: int

    @property
    def month_code(self) -> str:
        return MONTH_CODES[self.month]

    @property
    def expiry(self) -> date:
        return third_friday(self.year, self.month)

    @property
    def roll_date(self) -> date:
        """The session on which this contract stops being the front month."""

        return self.expiry - timedelta(days=ROLL_OFFSET_DAYS)

    def next_quarter(self) -> "ContractMonth":
        index = QUARTERLY_MONTHS.index(self.month)
        if index + 1 < len(QUARTERLY_MONTHS):
            return ContractMonth(self.year, QUARTERLY_MONTHS[index + 1])
        return ContractMonth(self.year + 1, QUARTERLY_MONTHS[0])

    def __str__(self) -> str:  # pragma: no cover - debugging helper
        return f"{self.year}{self.month_code}"


def front_month(on: date) -> ContractMonth:
    """The contract trading as front month on ``on``.

    The first quarterly contract whose roll date has not arrived yet.  On the
    roll date itself the *next* contract is already front month.
    """

    for year in (on.year - 1, on.year, on.year + 1):
        for month in QUARTERLY_MONTHS:
            candidate = ContractMonth(year, month)
            if candidate.roll_date > on:
                return candidate
    raise ValueError(f"No quarterly contract found for {on}")  # pragma: no cover


def roll_boundary_ms(contract: ContractMonth, tz_name: str = EXCHANGE_TIMEZONE) -> int:
    """Exchange-local midnight of ``contract``'s roll date, in Unix ms."""

    tz = ZoneInfo(tz_name)
    midnight = datetime.combine(contract.roll_date, datetime.min.time(), tzinfo=tz)
    return int(midnight.timestamp() * 1000)


@dataclass(frozen=True)
class ContractSegment:
    """The slice of a request window served by one contract."""

    contract: ContractMonth
    start_ms: int
    #: Inclusive.  The last millisecond before the next contract takes over.
    end_ms: int


def contract_segments(
    start_ms: int,
    end_ms: int,
    *,
    tz_name: str = EXCHANGE_TIMEZONE,
) -> list[ContractSegment]:
    """Split ``[start_ms, end_ms]`` into consecutive front-month segments.

    A window inside one contract's life yields a single segment; a window that
    spans a roll yields one segment per contract, cut at exchange-local
    midnight on each roll date.
    """

    if end_ms < start_ms:
        raise ValueError("end_ms must not precede start_ms")

    tz = ZoneInfo(tz_name)
    segments: list[ContractSegment] = []
    cursor = start_ms

    while cursor <= end_ms:
        local_day = datetime.fromtimestamp(cursor / 1000, tz=tz).date()
        contract = front_month(local_day)
        boundary = roll_boundary_ms(contract, tz_name)
        segment_end = min(end_ms, boundary - 1)
        segments.append(ContractSegment(contract, cursor, segment_end))
        cursor = segment_end + 1

    return segments
