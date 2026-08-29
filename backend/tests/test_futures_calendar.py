"""Tests for the quarterly front-month roll calendar.

Every expected date here was read off a calendar by hand rather than computed
with the same helper under test, so a failure means the rule moved, not that
two copies of one bug agree.
"""

from __future__ import annotations

from datetime import date

import pytest

from app.providers.futures_calendar import (
    ContractMonth,
    contract_segments,
    front_month,
    roll_boundary_ms,
    third_friday,
)
from app.providers.massive_provider import contract_ticker


class TestExpiryAndRoll:
    @pytest.mark.parametrize(
        ("year", "month", "expected"),
        [
            (2026, 3, date(2026, 3, 20)),
            (2026, 6, date(2026, 6, 19)),
            (2026, 9, date(2026, 9, 18)),
            (2026, 12, date(2026, 12, 18)),
            # A month whose first day is itself a Friday.
            (2026, 5, date(2026, 5, 15)),
        ],
    )
    def test_third_friday(self, year: int, month: int, expected: date) -> None:
        assert third_friday(year, month) == expected

    def test_roll_is_the_second_thursday(self) -> None:
        contract = ContractMonth(2026, 9)
        assert contract.expiry == date(2026, 9, 18)
        assert contract.roll_date == date(2026, 9, 10)
        assert contract.roll_date.weekday() == 3  # Thursday

    def test_month_code(self) -> None:
        assert ContractMonth(2026, 3).month_code == "H"
        assert ContractMonth(2026, 6).month_code == "M"
        assert ContractMonth(2026, 9).month_code == "U"
        assert ContractMonth(2026, 12).month_code == "Z"

    def test_next_quarter_wraps_the_year(self) -> None:
        assert ContractMonth(2026, 9).next_quarter() == ContractMonth(2026, 12)
        assert ContractMonth(2026, 12).next_quarter() == ContractMonth(2027, 3)


class TestFrontMonth:
    def test_mid_quarter(self) -> None:
        assert front_month(date(2026, 8, 29)) == ContractMonth(2026, 9)

    def test_day_before_roll_still_holds(self) -> None:
        assert front_month(date(2026, 9, 9)) == ContractMonth(2026, 9)

    def test_roll_date_hands_over_to_the_next_contract(self) -> None:
        assert front_month(date(2026, 9, 10)) == ContractMonth(2026, 12)

    def test_between_roll_and_expiry_is_already_the_next_contract(self) -> None:
        # The old contract still trades until the 18th, but volume has moved.
        assert front_month(date(2026, 9, 15)) == ContractMonth(2026, 12)

    def test_year_end_rolls_into_march(self) -> None:
        assert front_month(date(2026, 12, 11)) == ContractMonth(2027, 3)
        assert front_month(date(2027, 1, 5)) == ContractMonth(2027, 3)


class TestContractSegments:
    def test_window_inside_one_contract_is_one_segment(self) -> None:
        start = roll_boundary_ms(ContractMonth(2026, 6))
        end = start + 5 * 86_400_000
        segments = contract_segments(start, end)
        assert len(segments) == 1
        assert segments[0].contract == ContractMonth(2026, 9)
        assert (segments[0].start_ms, segments[0].end_ms) == (start, end)

    def test_window_spanning_a_roll_splits_at_the_boundary(self) -> None:
        boundary = roll_boundary_ms(ContractMonth(2026, 9))
        start = boundary - 3 * 86_400_000
        end = boundary + 3 * 86_400_000
        segments = contract_segments(start, end)

        assert [segment.contract for segment in segments] == [
            ContractMonth(2026, 9),
            ContractMonth(2026, 12),
        ]
        assert segments[0].end_ms == boundary - 1
        assert segments[1].start_ms == boundary

    def test_segments_are_contiguous_and_cover_the_window(self) -> None:
        start = roll_boundary_ms(ContractMonth(2025, 12))
        end = start + 400 * 86_400_000
        segments = contract_segments(start, end)

        assert len(segments) > 1, "a 400-day window must cross a roll"
        assert segments[0].start_ms == start
        assert segments[-1].end_ms == end
        for earlier, later in zip(segments, segments[1:]):
            assert later.start_ms == earlier.end_ms + 1
            assert later.contract == earlier.contract.next_quarter()

    def test_rejects_a_backwards_window(self) -> None:
        with pytest.raises(ValueError):
            contract_segments(1_000, 999)


class TestContractTicker:
    def test_formats_the_massive_ticker(self) -> None:
        assert contract_ticker("ES", ContractMonth(2026, 9)) == "ESU6"
        assert contract_ticker("NQ", ContractMonth(2026, 12)) == "NQZ6"
        assert contract_ticker("YM", ContractMonth(2027, 3)) == "YMH7"
