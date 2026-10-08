"""Boundary cases discovered in the handover bug hunt, using offline data."""
from dataclasses import replace
from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pytest
from pydantic import ValidationError

from app.backtesting.engine import BacktestEngine, MatchInput
from app.backtesting.metrics import _compound, _equity_curve
from app.learning.block_weights import _per_query
from app.models.domain import Candle
from app.models.schemas import BacktestRequest, TradeRules
from app.providers.futures_calendar import ContractMonth, contract_segments, roll_boundary_ms
from app.utils.timeutils import parse_time_param

HOUR = 3_600_000


def bars(count=12):
    return [Candle(symbol="ES", time=i * HOUR, open=100, high=100.1,
                   low=99.9, close=100, volume=10) for i in range(count)]


def request(**kwargs):
    return BacktestRequest(primary_symbol="ES", interval=kwargs.pop("interval", "1h"),
                           selection={"start_time": 0, "end_time": 10 * HOUR},
                           search={"lookback_start": 0, "lookback_end": 100 * HOUR}, **kwargs)


@pytest.mark.parametrize("direction,opening", [("long", 104), ("short", 96)])
def test_opening_beyond_target_wins_before_intrabar_stop(direction, opening):
    candles = bars()
    candles[5] = candles[5].model_copy(update={"open": opening, "high": 105, "low": 95})
    rules = TradeRules(direction=direction, fee_percent=0, slippage_percent=0)
    trades, _ = BacktestEngine(candles, rules).run([MatchInput("m", 0, 4, 1)])
    assert trades[0].exit_reason == "take_profit"
    assert trades[0].exit_price == opening
    assert not trades[0].same_bar_ambiguity


def test_masked_candidates_never_fill_a_short_top_k():
    result = _per_query(np.array([[0.5, -np.inf, -np.inf], [-np.inf] * 3]),
                        np.array([2., 100., 100.]), 3)
    assert result[0] == 2
    assert np.isnan(result[1])


def test_bankrupt_equity_cannot_turn_positive_again():
    trade = BacktestEngine(bars(), TradeRules()).run([MatchInput("m", 0, 4, 1)])[0][0]
    points, drawdown = _equity_curve([replace(trade, net_return=-150),
                                      replace(trade, net_return=-150)])
    assert [point.equity for point in points] == [0, 0]
    assert drawdown == 100
    assert _compound([-150, -150]) == -100


@pytest.mark.parametrize("base,higher", [("4h", "6h"), ("90m", "4h"),
                                        ("1h", "90m"), ("1w", "1mo")])
def test_bias_rejects_bars_that_cannot_be_aggregated_whole(base, higher):
    with pytest.raises(ValidationError):
        request(interval=base, higher_timeframe=higher)


@pytest.mark.parametrize("value", ["inf", "-inf", "nan", "1e999", float("inf")])
def test_nonfinite_time_is_a_validation_error(value):
    with pytest.raises(ValueError):
        parse_time_param(value)


@pytest.mark.parametrize("month,day", [(9, 9), (12, 9)])
def test_contract_rolls_at_open_of_the_thursday_session(month, day):
    local = datetime(2026, month, day, 17, tzinfo=ZoneInfo("America/Chicago"))
    expected = int(local.timestamp() * 1000)
    contract = ContractMonth(2026, month)
    assert roll_boundary_ms(contract) == expected
    segments = contract_segments(expected - 1, expected + 8 * HOUR)
    assert [segment.contract for segment in segments] == [contract, contract.next_quarter()]
    assert segments[0].end_ms == expected - 1
    assert segments[1].start_ms == expected


def test_gap_filled_on_the_entry_bar_is_not_live_at_its_close():
    from app.analysis.conditions import detectors_at_entry
    from test_conditions import gap

    state = detectors_at_entry(entry_price=100, entry_time=10 * HOUR, direction="long",
                               gaps=[gap(time=0, filled_time=10 * HOUR)], swings=[],
                               divergences=[], within_ms=HOUR, align_with_direction=True)
    assert state.fair_value_gap is None


def test_close_entry_session_uses_close_time():
    from app.services.backtest_service import BacktestService

    opening = parse_time_param("2026-09-01T06:00:00-04:00")
    candles = [bar.model_copy(update={"time": opening + i * HOUR}) for i, bar in enumerate(bars())]
    context = {"gaps": [], "swings": [], "divergences": [], "pools": []}
    reason = BacktestService(candle_service=object())._condition_reason(
        candles=candles, end_index=0, request=request(detectors={"sessions": ["new_york_am"]}),
        context=context, within_ms=HOUR)
    assert reason is None  # 06:00 bar closes at the 07:00 session open.


def test_monthly_bias_waits_until_the_calendar_month_closes():
    from app.analysis.bias import find_bias_states
    from app.analysis.structure import SwingPoint

    start = parse_time_param("2026-07-31T17:00:00-05:00")
    candle = bars(1)[0].model_copy(update={"time": start, "close": 110})
    swing = SwingPoint("ES", "high", 0, start - HOUR, 105, start - HOUR, 1)
    state = find_bias_states([candle], [swing], interval_ms=30 * 24 * HOUR,
                             interval="1mo")[0]
    assert state.known_from == parse_time_param("2026-08-31T17:00:00-05:00")


@pytest.mark.anyio
@pytest.mark.parametrize("interval", ["2m", "3m", "30m", "90m"])
async def test_analysis_chunks_fit_the_stored_interval_limit(interval, monkeypatch):
    from app.config import get_settings
    from app.models.domain import BarsResult
    from app.services import candle_service as module

    settings = get_settings().model_copy(update={"max_bars_per_request": 10})
    monkeypatch.setattr(module, "get_settings", lambda: settings)
    service = module.CandleService(provider=object())
    spans = []

    async def get_bars(symbol, requested, start, end):
        service.validate_request(symbol, requested, start, end)
        spans.append((start, end))
        return BarsResult(symbol=symbol, interval=requested, provider="demo", cached=False,
                          fallback_active=False, bars=[])

    monkeypatch.setattr(service, "get_bars", get_bars)
    start = parse_time_param("2026-09-01T12:00:00Z")
    await service.get_series_for_analysis("ES", interval, start, start + 5 * HOUR)
    assert len(spans) > 1
    assert spans[0][0] == start and spans[-1][1] == start + 5 * HOUR


@pytest.mark.anyio
async def test_finer_fetch_covers_whole_storage_edge_buckets(monkeypatch):
    from app.database.repository import TimeRange
    from app.models.domain import ProviderFetchResult
    from app.services.candle_service import CandleService, _PersistOutcome

    seen = []
    persisted = []

    class Provider:
        def chain(self):
            return ["yahoo"]

        async def fetch(self, symbol, interval, start, end):
            seen.append((int(start.timestamp() * 1000), int(end.timestamp() * 1000)))
            first = (seen[-1][0] + 299_999) // 300_000 * 300_000
            fetched = [Candle(symbol=symbol, time=t, open=100, high=101, low=99,
                              close=100, volume=1)
                       for t in range(first, seen[-1][1] + 1, 300_000)]
            return ProviderFetchResult(bars=fetched, provider="yahoo", interval="5m", quality="delayed")

    service = CandleService(provider=Provider())
    monkeypatch.setattr(service, "_compute_gaps", lambda *args: [TimeRange(HOUR + 1, 2 * HOUR + 1)])
    monkeypatch.setattr(service, "_persist", lambda *args: persisted.extend(args[2]) or _PersistOutcome.STORED)
    await service._ensure_cached("ES", "1h", TimeRange(HOUR, 3 * HOUR), force_refresh=True)
    assert seen == [(HOUR, 3 * HOUR - 1)]
    assert [(bar.time, bar.volume) for bar in persisted] == [(HOUR, 12), (2 * HOUR, 12)]


def test_random_baseline_excludes_training_on_every_symbol(monkeypatch):
    from types import SimpleNamespace
    from app.services import backtest_service as module

    excluded = []

    def draws(*args, **kwargs):
        excluded.append(kwargs["exclude_ranges"])
        return []

    monkeypatch.setattr(module, "baseline_inputs", draws)
    service = module.BacktestService(candle_service=object())
    series = {symbol: SimpleNamespace(candles=bars()) for symbol in ["ES", "NQ"]}
    service._draw_baseline(request=request(), query_length=5, required_future_bars=1,
                           exclusion=(50, 60), train_range=(0, 20), primary="ES",
                           by_symbol={"ES": [1], "NQ": [1]}, series_by_symbol=series,
                           detectors={}, within_ms=HOUR)
    assert excluded == [[(50, 60), (0, 20)], [(0, 20)]]


def test_overlap_rule_orders_all_symbols_together():
    from app.backtesting.engine import non_overlapping_trades

    trade = BacktestEngine(bars(), TradeRules()).run([MatchInput("m", 0, 4, 1)])[0][0]
    first = replace(trade, pattern_match_id="first", entry_time=0, exit_time=10, symbol="ES")
    blocked = replace(trade, pattern_match_id="blocked", entry_time=5, exit_time=6, symbol="NQ")
    later = replace(trade, pattern_match_id="later", entry_time=11, exit_time=12, symbol="NQ")
    kept, skipped = non_overlapping_trades([later, blocked, first])
    assert [t.pattern_match_id for t in kept] == ["first", "later"]
    assert [s.pattern_match_id for s in skipped] == ["blocked"]


def test_training_drops_labels_whose_exit_crosses_the_split(monkeypatch):
    from app.services import backtest_service as module
    from app.services.pattern_service import build_query

    candles = bars(130)
    req = request(learning={"enabled": True, "query_samples": 1},
                  trade={"maximum_holding_bars": 10})
    req.search.lookback_end = 120 * HOUR
    selection = candles[110:115]
    query = build_query(selection, "1h", 5, min_length=5, max_length=200)
    original_fit = module.fit_block_weights

    def fit(**kwargs):
        # 60 hours is the train boundary; only windows ending by hour 50
        # can resolve a ten-bar close entry without crossing it.
        assert len(kwargs["outcomes"]) == 46
        return original_fit(**kwargs)

    monkeypatch.setattr(module, "fit_block_weights", fit)
    service = module.BacktestService(candle_service=object())
    service._fit_weights(request=req, candles=candles, query=query, required_future_bars=10,
                         exclusion=(110 * HOUR, 114 * HOUR), selection_candles=selection)
