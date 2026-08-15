"""Delete saved backtest runs.

    python -m scripts.clear_backtests                # dry run: report only
    python -m scripts.clear_backtests --yes          # actually delete
    python -m scripts.clear_backtests --before 2026-08-10 --yes

Runs saved before a metrics change hold numbers computed by the old formulas
-- they are frozen in ``summary_json`` and are never recomputed on read. That
makes a stored history quietly inconsistent with anything measured since, so
clearing it is usually the honest option.

Only the ``backtests`` table and its children (``pattern_matches``,
``trades``) are touched. **The candle cache is left alone**: it is expensive to
refetch and has nothing to do with which formula produced a win rate. Use
``DELETE /api/cache`` if you want that cleared too.

Nothing is deleted without ``--yes``.
"""

from __future__ import annotations

import argparse
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, select  # noqa: E402

from app.config import get_settings  # noqa: E402
from app.database.session import session_scope  # noqa: E402
from app.models.db_models import BacktestRow, PatternMatchRow, TradeRow  # noqa: E402


def parse_date(value: str) -> int:
    """``YYYY-MM-DD`` -> Unix ms at midnight UTC."""

    parsed = datetime.strptime(value, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    return int(parsed.timestamp() * 1000)


def describe(created_at_ms: int) -> str:
    return datetime.fromtimestamp(created_at_ms / 1000, timezone.utc).strftime(
        "%d %b %Y, %H:%M"
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--yes",
        action="store_true",
        help="Perform the deletion. Without it, the script only reports.",
    )
    parser.add_argument(
        "--before",
        metavar="YYYY-MM-DD",
        help="Only delete runs created before this date. Default: all runs.",
    )
    args = parser.parse_args()

    cutoff = parse_date(args.before) if args.before else None

    with session_scope() as session:
        query = select(BacktestRow).order_by(BacktestRow.created_at)
        if cutoff is not None:
            query = query.where(BacktestRow.created_at < cutoff)
        runs = list(session.scalars(query))

        total_runs = session.scalar(select(func.count()).select_from(BacktestRow)) or 0

        if not runs:
            print(f"Nothing to delete. {total_runs} saved run(s) in the database.")
            return 0

        ids = [run.id for run in runs]
        match_count = (
            session.scalar(
                select(func.count())
                .select_from(PatternMatchRow)
                .where(PatternMatchRow.backtest_id.in_(ids))
            )
            or 0
        )
        trade_count = (
            session.scalar(
                select(func.count())
                .select_from(TradeRow)
                .where(TradeRow.backtest_id.in_(ids))
            )
            or 0
        )

        print(f"Database: {get_settings().resolved_database_url}")
        print(f"Matching runs: {len(runs)} of {total_runs} saved\n")
        for run in runs:
            summary = run.summary_json or {}
            win_rate = summary.get("win_rate")
            shown = f"{win_rate:.0f}% win" if isinstance(win_rate, (int, float)) else run.status
            print(
                f"  {describe(run.created_at)}  {run.primary_symbol:<3} "
                f"{run.interval:<3}  {shown}"
            )
        print(f"\nCascades to {match_count} pattern match(es) and {trade_count} trade(s).")
        print("The candle cache is not touched.")

        if not args.yes:
            print("\nDry run -- nothing deleted. Re-run with --yes to confirm.")
            return 0

        for run in runs:
            session.delete(run)

    print(f"\nDeleted {len(runs)} run(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
