"""Data-access layer.

Every SQL statement in the application lives here.  Services depend on these
functions rather than on the ORM directly, which keeps the door open for a
different storage engine later on.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from app.models.db_models import (
    BacktestRow,
    CacheCoverageRow,
    CandleRow,
    InstrumentRow,
    PatternMatchRow,
    TradeRow,
)
from app.models.domain import Candle
from app.utils.timeutils import now_ms

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class TimeRange:
    start: int
    end: int

    def __post_init__(self) -> None:
        if self.end < self.start:
            raise ValueError("TimeRange end must be >= start")

    @property
    def length(self) -> int:
        return self.end - self.start


# --------------------------------------------------------------------------
# Instruments
# --------------------------------------------------------------------------
def upsert_instruments(session: Session, instruments: list[dict]) -> None:
    for payload in instruments:
        existing = session.scalar(
            select(InstrumentRow).where(InstrumentRow.symbol == payload["symbol"])
        )
        if existing is None:
            session.add(InstrumentRow(**payload))
        else:
            for key, value in payload.items():
                setattr(existing, key, value)


def list_instruments(session: Session) -> list[InstrumentRow]:
    return list(session.scalars(select(InstrumentRow).order_by(InstrumentRow.symbol)))


# --------------------------------------------------------------------------
# Candle cache
# --------------------------------------------------------------------------
def save_candles(
    session: Session, interval: str, candles: list[Candle], provider: str
) -> int:
    """Insert candles, replacing any existing row with the same key.

    Uses SQLite's ``ON CONFLICT DO UPDATE``; for other engines it falls back to
    a portable delete-then-insert on the affected keys.
    """

    if not candles:
        return 0

    fetched = now_ms()
    rows = [
        {
            "symbol": candle.symbol,
            "interval": interval,
            "timestamp": candle.time,
            "open": candle.open,
            "high": candle.high,
            "low": candle.low,
            "close": candle.close,
            "volume": candle.volume,
            "provider": provider,
            "fetched_at": fetched,
        }
        for candle in candles
    ]

    dialect = session.get_bind().dialect.name
    if dialect == "sqlite":
        # Chunked to stay well below SQLite's variable limit.
        for chunk in _chunks(rows, 500):
            statement = sqlite_insert(CandleRow).values(chunk)
            statement = statement.on_conflict_do_update(
                index_elements=[CandleRow.symbol, CandleRow.interval, CandleRow.timestamp],
                set_={
                    "open": statement.excluded.open,
                    "high": statement.excluded.high,
                    "low": statement.excluded.low,
                    "close": statement.excluded.close,
                    "volume": statement.excluded.volume,
                    "provider": statement.excluded.provider,
                    "fetched_at": statement.excluded.fetched_at,
                },
            )
            session.execute(statement)
    else:  # pragma: no cover - exercised only on PostgreSQL
        symbol = candles[0].symbol
        timestamps = [candle.time for candle in candles]
        session.execute(
            delete(CandleRow).where(
                CandleRow.symbol == symbol,
                CandleRow.interval == interval,
                CandleRow.timestamp.in_(timestamps),
            )
        )
        session.bulk_insert_mappings(CandleRow, rows)  # type: ignore[arg-type]

    return len(rows)


def load_candles(
    session: Session, symbol: str, interval: str, start: int, end: int
) -> list[Candle]:
    rows = session.scalars(
        select(CandleRow)
        .where(
            CandleRow.symbol == symbol,
            CandleRow.interval == interval,
            CandleRow.timestamp >= start,
            CandleRow.timestamp <= end,
        )
        .order_by(CandleRow.timestamp.asc())
    )
    return [
        Candle(
            symbol=row.symbol,
            time=row.timestamp,
            open=row.open,
            high=row.high,
            low=row.low,
            close=row.close,
            volume=row.volume,
        )
        for row in rows
    ]


def candle_provider(session: Session, symbol: str, interval: str) -> str | None:
    return session.scalar(
        select(CandleRow.provider)
        .where(CandleRow.symbol == symbol, CandleRow.interval == interval)
        .order_by(CandleRow.fetched_at.desc())
        .limit(1)
    )


#: Provider name whose bars are generated rather than observed.  The whole
#: point of the checks below is that these must never be mixed into a series
#: of real prices: a chart cannot show you which candles were invented, and a
#: win rate computed across both is neither one thing nor the other.
DEMO_PROVIDER = "demo"

#: Providers whose bars are real market prices.  Everything else that can
#: appear in the provider column is not: the generated demo feed, and any
#: label this build no longer produces -- an experiment, a retired provider, a
#: name that was only ever written by hand.
#:
#: The rule is keyed on what is *known to be real* rather than on the one
#: known-fake name, because the fake names are open-ended and the real ones
#: are not.  Keying it the other way is what let 770 bars labelled "stub" sit
#: inside a real ES series through every startup repair: they were not "demo",
#: so nothing recognised them as anything to look at, and a quarter of the
#: chart was priced at 1.5 while the rest was priced at 7,267.
#:
#: Pinned against the provider classes by a test rather than imported from
#: them -- the database layer must not depend on the provider package.
REAL_PROVIDERS: frozenset[str] = frozenset({"massive", "yahoo"})


def providers_in_range(
    session: Session, symbol: str, interval: str, start: int, end: int
) -> set[str]:
    """Providers the stored bars in ``[start, end]`` actually came from.

    The response's provider name says who served the *fetch*; this says what
    the window is made of, which is the only one of the two a warning about
    synthetic data can be based on.
    """

    rows = session.execute(
        select(CandleRow.provider)
        .where(
            CandleRow.symbol == symbol,
            CandleRow.interval == interval,
            CandleRow.timestamp >= start,
            CandleRow.timestamp <= end,
        )
        .group_by(CandleRow.provider)
    ).all()
    return {row[0] for row in rows if row[0]}


def has_real_candles(session: Session, symbol: str, interval: str) -> bool:
    """Whether this series holds any bar that came from a live provider."""

    found = session.scalar(
        select(CandleRow.timestamp)
        .where(
            CandleRow.symbol == symbol,
            CandleRow.interval == interval,
            CandleRow.provider.in_(REAL_PROVIDERS),
        )
        .limit(1)
    )
    return found is not None


def drop_unreal_candles(session: Session, symbol: str, interval: str) -> int:
    """Delete every bar in a series that did not come from a real provider.

    That is the generated demo feed and anything else unrecognised -- see
    :data:`REAL_PROVIDERS` for why the test is "not known real" rather than
    "known fake".

    Coverage goes wholesale rather than by provider: ranges are merged as they
    are recorded, so a row labelled with one provider can vouch for bars from
    another, and a coverage row that outlived its candles is worse than none --
    it says "already fetched" about a stretch that is now empty.  Dropping it
    costs one refetch and restores the invariant.
    """

    removed = (
        session.execute(
            delete(CandleRow).where(
                CandleRow.symbol == symbol,
                CandleRow.interval == interval,
                CandleRow.provider.not_in(REAL_PROVIDERS),
            )
        ).rowcount
        or 0
    )
    if removed:
        session.execute(
            delete(CacheCoverageRow).where(
                CacheCoverageRow.symbol == symbol,
                CacheCoverageRow.interval == interval,
            )
        )
    return int(removed)


def repair_mixed_series(session: Session) -> dict[tuple[str, str], int]:
    """Evict unreal bars from any series that also holds real ones.

    A series is legitimately all demo -- that is the no-API-key path, and it is
    left alone.  The same grace covers a series that is entirely unrecognised:
    it may be the only record of something, and nothing is drawn beside real
    prices to misread.  What cannot stand is a series that is *part* invented,
    where the two are drawn as one continuous price line and only the provider
    column of each row can tell them apart.

    Returns the number of bars removed per ``(symbol, interval)`` it touched.
    """

    grouped = session.execute(
        select(CandleRow.symbol, CandleRow.interval, CandleRow.provider)
        .group_by(CandleRow.symbol, CandleRow.interval, CandleRow.provider)
    ).all()

    series: dict[tuple[str, str], set[str]] = {}
    for symbol, interval, provider in grouped:
        series.setdefault((symbol, interval), set()).add(provider)

    removed: dict[tuple[str, str], int] = {}
    for (symbol, interval), providers in series.items():
        real = providers & REAL_PROVIDERS
        unreal = providers - REAL_PROVIDERS
        # Both halves must be present: one without the other is a series that
        # is wholly one thing, and wholly one thing is readable.
        if not real or not unreal:
            continue
        count = drop_unreal_candles(session, symbol, interval)
        if count:
            removed[(symbol, interval)] = count
    return removed


def candle_bounds(session: Session, symbol: str, interval: str) -> tuple[int | None, int | None]:
    row = session.execute(
        select(func.min(CandleRow.timestamp), func.max(CandleRow.timestamp)).where(
            CandleRow.symbol == symbol, CandleRow.interval == interval
        )
    ).one()
    return row[0], row[1]


# --------------------------------------------------------------------------
# Coverage bookkeeping
# --------------------------------------------------------------------------
def load_coverage(session: Session, symbol: str, interval: str) -> list[TimeRange]:
    rows = session.execute(
        select(CacheCoverageRow.start_time, CacheCoverageRow.end_time)
        .where(CacheCoverageRow.symbol == symbol, CacheCoverageRow.interval == interval)
        .order_by(CacheCoverageRow.start_time.asc())
    ).all()
    return [TimeRange(start, end) for start, end in rows]


def record_coverage(
    session: Session, symbol: str, interval: str, start: int, end: int, provider: str
) -> None:
    """Add a covered range, merging it with any overlapping/adjacent ranges."""

    if end < start:
        return

    existing = session.scalars(
        select(CacheCoverageRow)
        .where(CacheCoverageRow.symbol == symbol, CacheCoverageRow.interval == interval)
        .order_by(CacheCoverageRow.start_time.asc())
    ).all()

    merged_start, merged_end = start, end
    to_remove: list[CacheCoverageRow] = []
    for row in existing:
        # Overlapping or touching ranges get absorbed.
        if row.start_time <= merged_end and row.end_time >= merged_start:
            merged_start = min(merged_start, row.start_time)
            merged_end = max(merged_end, row.end_time)
            to_remove.append(row)

    for row in to_remove:
        session.delete(row)
    session.flush()

    session.add(
        CacheCoverageRow(
            symbol=symbol,
            interval=interval,
            start_time=merged_start,
            end_time=merged_end,
            provider=provider,
            fetched_at=now_ms(),
        )
    )


def missing_ranges(covered: list[TimeRange], requested: TimeRange) -> list[TimeRange]:
    """Return the parts of ``requested`` that are not already covered."""

    gaps: list[TimeRange] = []
    cursor = requested.start
    for span in sorted(covered, key=lambda item: item.start):
        if span.end < cursor:
            continue
        if span.start > requested.end:
            break
        if span.start > cursor:
            gaps.append(TimeRange(cursor, min(span.start - 1, requested.end)))
        cursor = max(cursor, span.end + 1)
        if cursor > requested.end:
            break
    if cursor <= requested.end:
        gaps.append(TimeRange(cursor, requested.end))
    return [gap for gap in gaps if gap.end >= gap.start]


def clear_cache(session: Session, symbol: str | None = None) -> int:
    candle_stmt = delete(CandleRow)
    coverage_stmt = delete(CacheCoverageRow)
    if symbol:
        candle_stmt = candle_stmt.where(CandleRow.symbol == symbol)
        coverage_stmt = coverage_stmt.where(CacheCoverageRow.symbol == symbol)
    deleted = session.execute(candle_stmt).rowcount or 0
    session.execute(coverage_stmt)
    return int(deleted)


def cache_statistics(session: Session) -> list[dict]:
    rows = session.execute(
        select(
            CandleRow.symbol,
            CandleRow.interval,
            func.count(CandleRow.id),
            func.min(CandleRow.timestamp),
            func.max(CandleRow.timestamp),
            func.max(CandleRow.provider),
        ).group_by(CandleRow.symbol, CandleRow.interval)
    ).all()
    return [
        {
            "symbol": symbol,
            "interval": interval,
            "candles": count,
            "first_time": first,
            "last_time": last,
            "provider": provider,
        }
        for symbol, interval, count, first, last, provider in rows
    ]


def last_fetch_time(session: Session) -> int | None:
    return session.scalar(select(func.max(CandleRow.fetched_at)))


# --------------------------------------------------------------------------
# Backtests
# --------------------------------------------------------------------------
def create_backtest(session: Session, row: BacktestRow) -> BacktestRow:
    session.add(row)
    session.flush()
    return row


def get_backtest(session: Session, backtest_id: str) -> BacktestRow | None:
    return session.get(BacktestRow, backtest_id)


def list_backtests(session: Session, limit: int = 50) -> list[BacktestRow]:
    return list(
        session.scalars(
            select(BacktestRow).order_by(BacktestRow.created_at.desc()).limit(limit)
        )
    )


def get_matches(session: Session, backtest_id: str) -> list[PatternMatchRow]:
    return list(
        session.scalars(
            select(PatternMatchRow)
            .where(PatternMatchRow.backtest_id == backtest_id)
            .order_by(PatternMatchRow.rank.asc())
        )
    )


def get_trades(session: Session, backtest_id: str) -> list[TradeRow]:
    return list(
        session.scalars(
            select(TradeRow)
            .where(TradeRow.backtest_id == backtest_id)
            .order_by(TradeRow.trade_number.asc())
        )
    )


def delete_backtest(session: Session, backtest_id: str) -> bool:
    row = session.get(BacktestRow, backtest_id)
    if row is None:
        return False
    session.delete(row)
    return True


def _chunks(items: list[dict], size: int):
    for index in range(0, len(items), size):
        yield items[index : index + size]


def configurations_against_selection(
    session: Session,
    *,
    primary_symbol: str,
    interval: str,
    selection_start: int,
    selection_end: int,
) -> list[dict]:
    """Configurations of every past run whose selection overlaps this one.

    Overlap rather than an exact match, using the same predicate the rest of
    the codebase uses for two ranges touching.  A window nudged by one bar is
    the same hunt over the same stretch of history, and counting it as a fresh
    start is how the tally would end up flattering: drag the edge, get a clean
    slate, quote the single-test p-value again.

    Returns the raw configuration payloads.  Turning them into keys is the
    caller's job, because the key definition lives with the thing that knows
    what changes an answer.
    """

    rows = session.execute(
        select(BacktestRow.configuration_json).where(
            BacktestRow.primary_symbol == primary_symbol,
            BacktestRow.interval == interval,
            BacktestRow.selection_start <= selection_end,
            BacktestRow.selection_end >= selection_start,
        )
    ).all()
    return [row[0] for row in rows if isinstance(row[0], dict)]
