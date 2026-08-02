"""Regenerate the bundled demo datasets.

    python -m scripts.generate_demo_data [--end 2026-08-01] [--days 180]

The output is deterministic: the same arguments always produce byte-identical
files.
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.config import get_settings  # noqa: E402
from app.providers.instruments import SUPPORTED_SYMBOLS  # noqa: E402
from app.services.demo_data import (  # noqa: E402
    DEFAULT_END_DATE,
    DEMO_SPAN_DAYS,
    write_demo_dataset,
)


def main() -> int:
    parser = argparse.ArgumentParser(description="Generate demo OHLCV datasets")
    parser.add_argument("--end", default=DEFAULT_END_DATE, help="ISO date the series ends on")
    parser.add_argument("--days", type=int, default=DEMO_SPAN_DAYS, help="Calendar days of history")
    parser.add_argument("--out", default=None, help="Output directory")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")
    directory = Path(args.out) if args.out else get_settings().demo_dir

    for symbol in SUPPORTED_SYMBOLS:
        path = write_demo_dataset(directory, symbol, end_date=args.end, span_days=args.days)
        size_mb = path.stat().st_size / (1024 * 1024)
        print(f"{symbol}: {path} ({size_mb:.2f} MB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
