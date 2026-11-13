"""Causality and end-to-end persistence for the explicit research hypothesis."""
from contextlib import contextmanager
from datetime import datetime

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.analysis.gxt import complete_profiles, find_gxt_signals
from app.models.db_models import Base
from app.models.domain import BarsResult, Candle
from app.models.schemas import BacktestRequest, GxtSettings, SearchSettings, SelectionSpec, TradeRules
from app.services.backtest_service import BacktestService, BacktestValidationError
from app.utils.intervals import HOUR_MS

BASE = int(datetime.fromisoformat("2026-01-05T23:00:00+00:00").timestamp() * 1000)


def market(short=False):
    rows = [(110, 140, 100, 110)] * 4 + [(101, 108, 98, 104)] * 4 + [
        (104, 105, 102, 104), (104, 109, 103, 108), (108, 110, 107, 109),
        (109, 115, 108, 112), (112, 141, 111, 140), (140, 142, 138, 140),
    ]
    if short:
        rows = [(200-o, 200-l, 200-h, 200-c) for o, h, l, c in rows]
    return [Candle(symbol="NQ", time=BASE+i*HOUR_MS, open=o, high=h, low=l, close=c)
            for i, (o, h, l, c) in enumerate(rows)]


def reference(bars):
    return [Candle(symbol="ES", time=b.time, open=200, high=210, low=190, close=199) for b in bars]


def continuation_market(short=False):
    rows = [(110, 140, 100, 115), (115, 120, 105, 115),
            (105, 110, 100, 104), (101, 109, 98, 106),
            (106, 112, 105, 110), (110, 141, 109, 140)]
    if short:
        rows = [(200-o, 200-l, 200-h, 200-c) for o,h,l,c in rows]
    return [Candle(symbol='NQ', time=BASE+i*HOUR_MS, open=o, high=h, low=l, close=c)
            for i,(o,h,l,c) in enumerate(rows)]


@pytest.mark.parametrize('short', [False, True])
def test_source_linked_continuation_is_known_at_new_4h_open(short):
    bars = continuation_market(short)
    found = signals(bars, sequence_model='c2_continuation')
    assert len(found) == 1
    e = found[0].evidence
    assert e.confirmed_at == BASE+4*HOUR_MS
    assert e.direction == ('short' if short else 'long')
    assert e.gap_bottom is None and e.gap_top is None
    assert e.source_links
    assert signals(bars[:5], sequence_model='c2_continuation') == found
    changed = bars[:4]+[b.model_copy(update={'high': 500, 'low': 1}) for b in bars[4:]]
    assert signals(changed, sequence_model='c2_continuation') == found


def test_continuation_requires_actual_1h_c2_sweep_and_matched_data():
    bars = continuation_market()
    assert signals(bars, {'ES': reference(bars)[1:]}, sequence_model='c2_continuation')
    assert not signals(bars, {'ES': reference(bars)[:3]}, sequence_model='c2_continuation')
    bars[3] = bars[3].model_copy(update={'low': 100})
    assert not signals(bars, sequence_model='c2_continuation')


def signals(bars, refs=None, **settings):
    return find_gxt_signals(
        bars, {"ES": reference(bars)} if refs is None else refs, interval="1h",
        settings=GxtSettings(**settings), tick_size=0.25,
        start=BASE, end=bars[-1].time + HOUR_MS,
    )[0]


@pytest.mark.parametrize("short", [False, True])
def test_symmetric_signals_are_known_only_at_ltf_close(short):
    bars = market(short)
    result = signals(bars)
    assert len(result) == 1
    e = result[0].evidence
    assert e.direction == ("short" if short else "long")
    assert e.context_end == BASE + 8 * HOUR_MS
    assert e.confirmed_at == BASE + 11 * HOUR_MS
    assert e.target_price == (60 if short else 140)
    assert e.stop_price == (102.25 if short else 97.75)
    assert e.reference_symbols == ["ES"]


def test_prefix_and_future_mutation_cannot_change_confirmed_signal():
    bars = market()
    assert not signals(bars[:10])  # No third confirmation candle yet.
    prefix = signals(bars[:11])
    assert prefix == signals(bars)
    changed = bars[:11] + [b.model_copy(update={"high": 500, "close": 400}) for b in bars[11:]]
    assert signals(changed)[0] == prefix[0]


def test_partial_4h_and_missing_reference_never_confirm():
    bars = market()
    assert signals(bars[:5] + bars[6:]) == []
    assert signals(bars, {"ES": reference(bars)[1:]}) == []
    assert signals(bars, {}) == []
    assert len(signals(bars, {}, require_cross_asset=False)) == 1


def test_both_sides_swept_and_preentry_invalidation_reject():
    bars = market()
    bars[4] = bars[4].model_copy(update={"high": 150})
    assert signals(bars) == []
    bars = market()
    bars[8] = bars[8].model_copy(update={"low": 90})
    assert signals(bars) == []


def test_ltf_gap_requires_contiguity_and_new_post_profile_bars():
    bars = market()
    assert signals(bars[:9] + bars[10:]) == []
    assert signals(bars, confirmation_bars=3)  # All three occur after C2 close.
    assert not signals(bars, minimum_body_fraction=0.9)


def test_ny_morning_filter_uses_wall_clock():
    assert signals(market(), ny_morning_only=True) == []


@pytest.mark.parametrize("base", ["2026-01-05T23:00:00+00:00", "2026-07-06T22:00:00+00:00"])
def test_complete_profile_session_grid_tracks_dst(base):
    start = int(datetime.fromisoformat(base).timestamp() * 1000)
    bars = [b.model_copy(update={"time": start+i*HOUR_MS}) for i, b in enumerate(market()[:4])]
    assert list(complete_profiles(bars, HOUR_MS, start+4*HOUR_MS)) == [start]
    assert complete_profiles(bars, HOUR_MS, start+4*HOUR_MS-1) == {}


def test_duplicate_timestamps_rejected():
    bars = market()
    with pytest.raises(ValueError, match="unique"):
        signals([bars[0], *bars])


@pytest.mark.parametrize("start_hour, expected", [(9, 1), (11, 1), (12, 0)])
def test_warmup_profile_can_confirm_inside_window_but_never_before_it(start_hour, expected):
    bars = market()
    found, _ = find_gxt_signals(
        bars, {"ES": reference(bars)}, interval="1h", settings=GxtSettings(),
        tick_size=0.25, start=BASE + start_hour * HOUR_MS, end=BASE + 14 * HOUR_MS,
    )
    assert len(found) == expected
    assert all(s.evidence.confirmed_at >= BASE + start_hour * HOUR_MS for s in found)


def test_invalidation_during_warmup_still_blocks_entry():
    bars = market()
    bars[8] = bars[8].model_copy(update={"low": 90})
    found, stats = find_gxt_signals(
        bars, {"ES": reference(bars)}, interval="1h", settings=GxtSettings(),
        tick_size=0.25, start=BASE + 10 * HOUR_MS, end=BASE + 14 * HOUR_MS,
    )
    assert not found
    assert stats["invalidated_before_confirmation"] == 1


class FakeFeed:
    def __init__(self, bars=None, mixed=False, empty_reference=False):
        self.bars = bars or market()
        self.mixed = mixed
        self.empty_reference = empty_reference

    async def get_series_for_analysis(self, symbol, interval, start, end):
        demo = self.mixed and symbol == "ES"
        bars = self.bars if symbol == "NQ" else ([] if self.empty_reference else reference(self.bars))
        return BarsResult(symbol=symbol, interval=interval, provider="demo" if demo else "fixture",
                          cached=True, fallback_active=False, quality="demo" if demo else "cached", bars=bars)


def request(**gxt):
    return BacktestRequest(
        strategy="gxt_research", primary_symbol="NQ", symbols=["NQ", "ES"], interval="1h",
        selection=SelectionSpec(start_time=BASE, end_time=BASE+14*HOUR_MS),
        search=SearchSettings(lookback_start=BASE, lookback_end=BASE+14*HOUR_MS),
        trade=TradeRules(fee_percent=0, slippage_percent=0, maximum_holding_bars=3),
        gxt=GxtSettings(**gxt),
    )


@pytest.fixture
def isolated_db(tmp_path, monkeypatch):
    engine = create_engine(f"sqlite:///{tmp_path / 'test.db'}", connect_args={"check_same_thread": False})
    Base.metadata.create_all(engine)
    @contextmanager
    def sessions():
        with Session(engine) as session:
            yield session
            session.commit()
    monkeypatch.setattr("app.services.gxt_service.session_scope", sessions)
    monkeypatch.setattr("app.services.backtest_service.session_scope", sessions)
    yield
    engine.dispose()


@pytest.mark.asyncio
async def test_run_reload_trade_levels_and_saved_evidence(isolated_db):
    service = BacktestService(FakeFeed())
    result = await service.run(request(), "gxt-test")
    assert len(result.trades) == 1
    trade = result.trades[0]
    assert (trade.entry_time, trade.entry_price) == (BASE+11*HOUR_MS, 109)
    assert (trade.stop_price, trade.target_price, trade.exit_reason) == (97.75, 140, "take_profit")
    assert not result.summary.gxt.trained
    assert result.summary.learned_weights is None
    loaded = await service.load(result.id)
    assert loaded.summary.gxt == result.summary.gxt
    assert loaded.trades == result.trades
    assert loaded.configuration.strategy == "gxt_research"


@pytest.mark.asyncio
@pytest.mark.parametrize('short', [False, True])
async def test_continuation_simulates_and_reloads_real_trade(short, isolated_db):
    service = BacktestService(FakeFeed(continuation_market(short)))
    req = request(sequence_model='c2_continuation', entry_interval='1h')
    result = await service.run(req, 'continuation')
    assert len(result.trades) == 1
    assert result.trades[0].entry_time == BASE+4*HOUR_MS
    assert result.trades[0].exit_reason == 'take_profit'
    assert result.summary.gxt.version == 'gxt-c2-continuation-v2'
    assert (await service.load(result.id)).trades == result.trades


@pytest.mark.asyncio
async def test_explicit_execution_interval_overrides_display_chart(isolated_db):
    class CheckingFeed(FakeFeed):
        async def get_series_for_analysis(self, symbol, interval, start, end):
            assert interval == '1h'
            return await super().get_series_for_analysis(symbol, interval, start, end)
    req = request(sequence_model='c2_continuation', entry_interval='1h')
    req.interval = '4h'
    result = await BacktestService(CheckingFeed(continuation_market())).run(req, 'entry-timeframe')
    assert result.interval == result.configuration.interval == '1h'
    assert result.trades


@pytest.mark.asyncio
async def test_gap_open_reward_risk_skips_without_retargeting(isolated_db):
    bars = market()
    bars[11] = bars[11].model_copy(update={"open": 135, "high": 138, "low": 130, "close": 134})
    result = await BacktestService(FakeFeed(bars)).run(request(), "gap")
    assert result.trades == []
    assert result.summary.skipped_matches == 1
    assert "reward/risk" in next(iter(result.summary.gxt.skipped.values()))
    assert "reward/risk" in result.summary.sample_size_warning


@pytest.mark.asyncio
async def test_incomplete_profiles_report_missing_history_instead_of_completed_zero_trades():
    with pytest.raises(BacktestValidationError, match="Insufficient GXT history"):
        await BacktestService(FakeFeed(market()[:7])).run(request(), "incomplete")


@pytest.mark.asyncio
async def test_unmatched_timestamps_report_coverage_error():
    class MisalignedFeed(FakeFeed):
        async def get_series_for_analysis(self, symbol, interval, start, end):
            result = await super().get_series_for_analysis(symbol, interval, start, end)
            if symbol == "ES":
                result.bars = [b.model_copy(update={"time": b.time + 60_000}) for b in result.bars]
            return result
    with pytest.raises(BacktestValidationError, match="not synchronized"):
        await BacktestService(MisalignedFeed()).run(request(), "misaligned")


@pytest.mark.asyncio
async def test_valid_zero_trade_run_explains_cross_asset_rejections(isolated_db):
    class SameSweepFeed(FakeFeed):
        async def get_series_for_analysis(self, symbol, interval, start, end):
            result = await super().get_series_for_analysis(symbol, interval, start, end)
            result.bars = [b.model_copy(update={"symbol": symbol}) for b in market()]
            return result
    result = await BacktestService(SameSweepFeed()).run(request(), "same-sweep")
    assert result.trades == []
    assert result.summary.gxt.diagnostics["no_cross_asset_divergence"] == 1
    assert "Every sweep/reclaim profile failed" in result.summary.sample_size_warning


@pytest.mark.asyncio
async def test_trade_stops_at_missing_history(isolated_db):
    bars = market()
    result = await BacktestService(FakeFeed(bars[:12]+bars[13:])).run(request(), "gap")
    assert result.trades[0].exit_reason == "end_of_data"
    assert result.trades[0].exit_time == bars[11].time


@pytest.mark.asyncio
@pytest.mark.parametrize("short", [False, True])
async def test_ambiguous_stop_and_target_conservative(short, isolated_db):
    bars = market(short)
    bars[11] = bars[11].model_copy(update={"high": 150, "low": 50})
    result = await BacktestService(FakeFeed(bars)).run(request(), "ambiguous")
    assert result.trades[0].exit_reason == "stop_loss"
    assert result.trades[0].same_bar_ambiguity


@pytest.mark.asyncio
@pytest.mark.parametrize("feed, error", [(FakeFeed(mixed=True), "synthetic"), (FakeFeed(empty_reference=True), "comparison")])
async def test_unusable_comparisons_are_explicit_errors(feed, error):
    with pytest.raises(BacktestValidationError, match=error):
        await BacktestService(feed).run(request(), "bad-source")


@pytest.mark.asyncio
async def test_weight_learning_cannot_masquerade_as_gxt():
    req = request()
    req.learning.enabled = True
    with pytest.raises(BacktestValidationError, match="does not train"):
        await BacktestService(FakeFeed()).run(req, "training")
