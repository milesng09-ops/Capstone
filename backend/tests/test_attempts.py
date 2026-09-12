"""Counting the draws, so a 1-in-20 result on the 20th try reads as arithmetic.

Two ways this could quietly flatter, and both are covered below: a key that
changes on its own would reset the count while the user changed nothing, and a
count keyed to an exact selection would reset when the window is nudged. Either
one hands back the single-test p-value on the twentieth attempt.
"""

from __future__ import annotations

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.backtesting.attempts import (
    configuration_key,
    describe_configuration,
    family_wise_probability,
)
from app.backtesting.metrics import compute_metrics
from app.database.repository import configurations_against_selection
from app.models.db_models import Base, BacktestRow
from app.models.schemas import BacktestRequest

HOUR = 3_600_000
T0 = 1_780_000_000_000


def request(**overrides) -> BacktestRequest:
    payload = {
        "symbols": ["ES", "NQ"],
        "primary_symbol": "ES",
        "interval": "1h",
        "selection": {"start_time": T0, "end_time": T0 + 12 * HOUR},
        "trade": {"direction": "long", "stop_loss_value": 1.0},
        "search": {
            "lookback_start": T0 - 1000 * HOUR,
            "lookback_end": T0,
            "maximum_matches": 25,
            "minimum_similarity": 0.75,
        },
    }
    for key, value in overrides.items():
        if isinstance(value, dict) and isinstance(payload.get(key), dict):
            payload[key] = {**payload[key], **value}
        else:
            payload[key] = value
    return BacktestRequest.model_validate(payload)


@pytest.fixture
def session() -> Session:
    engine = create_engine("sqlite://", future=True)
    Base.metadata.create_all(engine)
    with Session(bind=engine, expire_on_commit=False) as session:
        yield session


def record(session: Session, req: BacktestRequest, backtest_id: str) -> None:
    session.add(
        BacktestRow(
            id=backtest_id,
            created_at=T0,
            primary_symbol=req.primary_symbol,
            symbols=req.symbols,
            interval=req.interval,
            selection_start=req.selection.start_time,
            selection_end=req.selection.end_time,
            configuration_json=req.model_dump(mode="json"),
            provider="massive",
            status="complete",
        )
    )
    session.flush()


# --------------------------------------------------------------------------
class TestWhatCountsAsADifferentConfiguration:
    def test_the_same_settings_give_the_same_key(self):
        assert configuration_key(request()) == configuration_key(request())

    def test_moving_the_stop_is_a_different_attempt(self):
        assert configuration_key(request()) != configuration_key(
            request(trade={"stop_loss_value": 2.0})
        )

    def test_turning_on_a_detector_is_a_different_attempt(self):
        assert configuration_key(request()) != configuration_key(
            request(detectors={"require_fair_value_gap": True})
        )

    def test_the_selection_is_not_part_of_the_key(self):
        # The selection names the family; the key separates attempts inside it.
        moved = request(selection={"start_time": T0 + 5 * HOUR})
        assert configuration_key(moved) == configuration_key(request())

    def test_the_lookback_drifting_forward_is_not_a_new_attempt(self):
        """The one that would reset the count while nothing was changed.

        Absolute lookback bounds move on their own as candles arrive. Keyed on
        those, identical settings would hash differently tomorrow and hand
        back a fresh count.
        """

        later = request(
            search={
                "lookback_start": T0 - 1000 * HOUR + 50 * HOUR,
                "lookback_end": T0 + 50 * HOUR,
            }
        )
        assert configuration_key(later) == configuration_key(request())

    def test_actually_widening_the_lookback_is_a_new_attempt(self):
        wider = request(search={"lookback_start": T0 - 2000 * HOUR})
        assert configuration_key(wider) != configuration_key(request())


class TestFindingPriorAttempts:
    def test_a_fresh_window_has_no_history(self, session):
        assert configurations_against_selection(
            session,
            primary_symbol="ES",
            interval="1h",
            selection_start=T0,
            selection_end=T0 + 12 * HOUR,
        ) == []

    def test_a_nudged_window_still_finds_them(self, session):
        """Dragging the edge must not hand back a clean slate."""

        record(session, request(), "a")
        found = configurations_against_selection(
            session,
            primary_symbol="ES",
            interval="1h",
            # Shifted by an hour: overlapping, so the same hunt.
            selection_start=T0 + HOUR,
            selection_end=T0 + 13 * HOUR,
        )
        assert len(found) == 1

    def test_a_window_that_does_not_overlap_is_a_different_hunt(self, session):
        record(session, request(), "a")
        found = configurations_against_selection(
            session,
            primary_symbol="ES",
            interval="1h",
            selection_start=T0 + 500 * HOUR,
            selection_end=T0 + 512 * HOUR,
        )
        assert found == []

    def test_another_symbol_is_a_different_hunt(self, session):
        record(session, request(), "a")
        found = configurations_against_selection(
            session,
            primary_symbol="NQ",
            interval="1h",
            selection_start=T0,
            selection_end=T0 + 12 * HOUR,
        )
        assert found == []

    def test_every_overlapping_run_comes_back(self, session):
        record(session, request(), "a")
        record(session, request(trade={"stop_loss_value": 2.0}), "b")
        record(session, request(trade={"stop_loss_value": 3.0}), "c")
        found = configurations_against_selection(
            session,
            primary_symbol="ES",
            interval="1h",
            selection_start=T0,
            selection_end=T0 + 12 * HOUR,
        )
        keys = {configuration_key(BacktestRequest.model_validate(p)) for p in found}
        assert len(keys) == 3


class TestWhatTheDrawsDoToAPValue:
    def test_one_configuration_leaves_it_alone(self):
        assert family_wise_probability(0.03, 1) == 0.03

    def test_ten_draws_at_three_percent_is_a_one_in_four_shot(self):
        assert family_wise_probability(0.03, 10) == pytest.approx(0.2626, abs=1e-4)

    def test_it_rises_with_every_extra_draw(self):
        values = [family_wise_probability(0.05, k) for k in range(1, 20)]
        assert values == sorted(values)

    def test_it_stays_a_probability(self):
        assert family_wise_probability(0.5, 100) <= 1.0
        assert family_wise_probability(0.0, 100) == 0.0


class TestTheSummarySaysSo:
    def test_a_first_run_carries_no_warning_about_attempts(self):
        summary = compute_metrics([], total_matches=0, skipped_matches=0)
        assert summary.configurations_tried == 1
        assert not any("distinct configurations" in a for a in summary.assumptions)

    def test_repeated_attempts_are_named_in_the_assumptions(self):
        summary = compute_metrics(
            [], total_matches=0, skipped_matches=0, configurations_tried=12
        )
        assert summary.configurations_tried == 12


class TestNamingARunInAList:
    """Forty rows reading "ES 1h - 28% win" are worse than no list at all.

    The label exists to answer one question: what did I already try against
    this window? So the test that matters is not that it renders, but that
    two runs which differ are named differently -- and that two which do not
    differ are named the same, since the counter treats those as one draw.
    """

    BASE = {
        "trade": {
            "direction": "long",
            "stop_loss_type": "percentage",
            "stop_loss_value": 0.5,
            "take_profit_type": "risk_reward",
            "take_profit_value": 2.0,
        }
    }

    def test_it_names_the_rules_in_the_units_they_were_set_in(self):
        assert describe_configuration(self.BASE) == "Long · 0.5% → 2R"

    def test_an_atr_stop_is_not_described_as_a_percentage(self):
        payload = {
            "trade": {
                **self.BASE["trade"],
                "stop_loss_type": "atr_multiple",
                "stop_loss_value": 1.5,
            }
        }
        assert "1.5×ATR" in describe_configuration(payload)
        assert "1.5%" not in describe_configuration(payload)

    def test_conditions_appear_only_when_required(self):
        assert "FVG" not in describe_configuration(self.BASE)
        with_gap = {**self.BASE, "detectors": {"require_fair_value_gap": True}}
        assert "FVG" in describe_configuration(with_gap)

    def test_two_fits_differing_only_in_the_split_are_named_differently(self):
        """The failure this had on its first pass.

        Shape and objective alone left a column of fitted runs reading
        identically while being different configurations -- the same problem
        the label was added to fix, one level down.
        """

        def fit(**over):
            return {
                **self.BASE,
                "learning": {
                    "enabled": True,
                    "grouped": True,
                    "objective": "win_rate",
                    "query_samples": 60,
                    "train_fraction": 0.5,
                    **over,
                },
            }

        assert describe_configuration(fit()) != describe_configuration(
            fit(train_fraction=0.6)
        )
        assert describe_configuration(fit()) != describe_configuration(
            fit(query_samples=150)
        )
        assert describe_configuration(fit()) != describe_configuration(
            fit(grouped=False)
        )
        assert describe_configuration(fit()) != describe_configuration(
            fit(objective="expectancy")
        )

    def test_the_same_configuration_is_named_the_same(self):
        # Matching the counter, which treats a rerun as one draw, not two.
        assert describe_configuration(self.BASE) == describe_configuration(
            {"trade": dict(self.BASE["trade"])}
        )

    def test_a_run_saved_under_an_older_shape_is_still_nameable(self):
        """Failing to parse one is not a reason to show nothing for it."""

        assert describe_configuration({}) == "default rules"
        assert describe_configuration({"trade": {}}) == "default rules"
        # Junk in the numeric fields must not raise on the way to a list.
        assert isinstance(
            describe_configuration({"trade": {"stop_loss_value": "wat"}}), str
        )
