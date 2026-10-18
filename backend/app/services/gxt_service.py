"""Run and persist the experimental GXT hypothesis through the existing simulator."""

from __future__ import annotations

import uuid

import anyio

from app.analysis.gxt import ALLOWED_INTERVALS, find_gxt_signals
from app.backtesting.engine import BacktestEngine, MatchInput
from app.backtesting.metrics import compute_metrics
from app.config import get_settings
from app.database.repository import create_backtest
from app.database.session import session_scope
from app.models.db_models import BacktestRow, PatternMatchRow, TradeRow
from app.models.schemas import BacktestRequest, BacktestResponse, GxtRunDetails, PatternMatchOut
from app.providers.instruments import get_instrument
from app.utils.intervals import DAY_MS, interval_ms
from app.utils.timeutils import now_ms


async def run_gxt_backtest(request: BacktestRequest, candle_service) -> BacktestResponse:
    # Local import keeps ordinary backtest loading independent of this scanner.
    from app.services.backtest_service import BacktestValidationError, _trade_out

    if request.interval not in ALLOWED_INTERVALS:
        raise BacktestValidationError("GXT research requires 1m, 2m, 3m, 5m, 15m, 30m or 1h candles.")
    if request.learning.enabled:
        raise BacktestValidationError("Similarity-weight learning does not train GXT. Disable it for GXT research.")
    if request.detectors.any_required:
        raise BacktestValidationError("GXT research uses its own sequence filters. Clear the pattern detector filters first.")
    primary = get_instrument(request.primary_symbol).symbol
    symbols = list(dict.fromkeys([primary, *(get_instrument(s).symbol for s in request.symbols)]))
    if len(symbols) > get_settings().max_symbols_per_workspace:
        raise BacktestValidationError("Too many symbols for this workspace.")
    if request.search.maximum_matches > get_settings().max_pattern_matches:
        raise BacktestValidationError("Requested signals exceed the workspace backtest limit.")
    if any(s not in {"ES", "NQ", "YM"} for s in symbols):
        raise BacktestValidationError("GXT research currently supports the ES/NQ/YM group only.")
    if request.gxt.require_cross_asset and len(symbols) < 2:
        raise BacktestValidationError("Add ES, NQ or YM as a comparison for the cross-asset check.")
    end = min(request.search.lookback_end, now_ms())
    start = request.search.lookback_start
    if end <= start:
        raise BacktestValidationError("The GXT test window must contain historical candles.")
    step = interval_ms(request.interval)
    series = {}
    for symbol in symbols:
        result = await candle_service.get_series_for_analysis(symbol, request.interval, start - 3 * DAY_MS, end)
        # A provider may include the forming last bar. Never simulate on it.
        series[symbol] = result.model_copy(update={
            "bars": [b for b in result.bars if start - 3 * DAY_MS <= b.time and b.time + step <= end]
        })
    primary_result = series[primary]
    if not primary_result.bars:
        raise BacktestValidationError("No completed candles are available in this GXT window.")
    if request.gxt.require_cross_asset and any(not result.bars for result in series.values()):
        raise BacktestValidationError("A comparison market has no completed data. GXT cannot confirm synchronization.")
    if request.gxt.require_cross_asset and len({r.quality == "demo" for r in series.values()}) > 1:
        raise BacktestValidationError("GXT cannot compare synthetic demo prices with real market prices.")
    if request.gxt.require_cross_asset and len({r.provider for r in series.values()}) > 1:
        raise BacktestValidationError("Use the same market-data provider for synchronized GXT comparisons.")

    def compute():
        candles = primary_result.bars
        signals, diagnostics = find_gxt_signals(
            candles, {s: r.bars for s, r in series.items() if s != primary},
            interval=request.interval, settings=request.gxt,
            tick_size=get_instrument(primary).tick_size, start=start, end=end,
        )
        # A cap selects the earliest signals, never the most profitable ones.
        diagnostics["signals_beyond_limit"] = max(0, len(signals) - request.search.maximum_matches)
        signals = signals[:request.search.maximum_matches]
        details = GxtRunDetails(diagnostics=diagnostics)
        trades, matches = [], []
        previous_exit = -1
        for rank, signal in enumerate(signals, start=1):
            match_id = str(uuid.uuid4())
            e = signal.evidence
            details.evidence[match_id] = e
            index = signal.end_index + 1
            reason = None
            if index >= len(candles) or candles[index].time != e.confirmed_at:
                reason = "No contiguous next-open entry candle."
            elif candles[index].time >= signal.expires_at:
                reason = "The 4H opportunity expired before entry."
            elif not request.trade.allow_overlapping_trades and candles[index].time <= previous_exit:
                reason = "An earlier trade is still open on this entry bar."
            elif index < len(candles):
                long = e.direction == "long"
                slipped = candles[index].open * (1 + (1 if long else -1) * request.trade.slippage_percent / 100)
                risk = slipped - e.stop_price if long else e.stop_price - slipped
                reward = e.target_price - slipped if long else slipped - e.target_price
                if risk <= 0 or reward <= 0:
                    reason = "The next open crossed the stop or target."
                elif reward / risk < request.gxt.minimum_reward_risk:
                    reason = "The next-open reward/risk is below the configured minimum."
            simulated = []
            if reason is None:
                rules = request.trade.model_copy(update={
                    "direction": e.direction, "entry_type": "next_open",
                    "stop_loss_type": "fixed_price", "stop_loss_value": e.stop_price,
                    "take_profit_type": "fixed_price", "take_profit_value": e.target_price,
                })
                # Stop before missing history. Treating a later candle as the
                # very next observation would conceal unknown stop/target hits.
                last = index + 1
                while last < min(len(candles), index + rules.maximum_holding_bars):
                    if candles[last].time != candles[last - 1].time + step:
                        break
                    last += 1
                simulated, skipped = BacktestEngine(candles[:last], rules).run([
                    MatchInput(match_id, signal.start_index, signal.end_index, 0.0)
                ])
                if skipped:
                    reason = skipped[0].reason
                if simulated:
                    previous_exit = simulated[0].exit_time
                    trades.extend(simulated)
                    if simulated[0].exit_reason == "end_of_data":
                        diagnostics["trades_truncated_by_data"] = diagnostics.get("trades_truncated_by_data", 0) + 1
            if reason:
                details.skipped[match_id] = reason
            trade = simulated[0] if simulated else None
            matches.append(PatternMatchOut(
                id=match_id, symbol=primary, interval=request.interval,
                start_time=candles[signal.start_index].time, end_time=e.signal_bar_time,
                similarity_score=0.0, euclidean_distance=0.0,
                entry_price=trade.entry_price if trade else candles[signal.end_index].close,
                rank=rank, outcome=trade.exit_reason if trade else "not_traded",
                net_return=trade.net_return if trade else None,
            ))
        details.diagnostics = diagnostics
        quality = [f"{s}: {r.provider}, {r.quality}, {len(r.bars)} completed {request.interval} candles." for s, r in series.items()]
        quality.extend(f"{s}: {r.fallback_reason}" for s, r in series.items() if r.fallback_reason)
        if any(r.quality == "demo" for r in series.values()):
            quality.append("Synthetic demo data: this is not evidence of market performance.")
        quality.append("Missing or shortened 4H buckets are excluded. Open trades stop at missing data and report end_of_data.")
        quality.append("Continuous futures are not roll-adjusted; contract-roll jumps may create spurious setups.")
        summary = compute_metrics(
            trades, total_matches=len(matches), skipped_matches=len(details.skipped), data_quality=quality,
            extra_assumptions=[
                "GXT research v1 is an experimental rule hypothesis, not a trained network or verified implementation of Garrett's complete model.",
                "Complete 4H candles use the exchange session grid (18:00 New York). Only closed candles can confirm a signal.",
                "C2 single-side sweep/reclaim → optional synchronized sweep divergence → lower-timeframe displacement gap → next open.",
                "Stop is beyond C2; target is the opposite C1 extreme. A failed entry is skipped, never retargeted.",
                "PSP and Strength Switch are not confirmed by this version; opposite candle bodies are recorded only as observations.",
                f"At most the earliest {request.search.maximum_matches} confirmed signals are tested. No similarity ranking or selected-example exclusion applies.",
                "No random-entry baseline or GXT recognition accuracy has been measured for this strategy.",
            ],
        )
        summary.assumptions = [a for a in summary.assumptions if not a.startswith("Historical matches are found")]
        if not trades:
            summary.sample_size_warning = "No trades passed the experimental sequence and execution rules. Inspect the GXT diagnostics and skipped signals."
        summary.gxt = details
        output_trades = [_trade_out(i, t) for i, t in enumerate(trades, 1)]
        for trade in output_trades:
            trade.id = str(uuid.uuid4())
        return summary, matches, output_trades

    try:
        summary, matches, trades = await anyio.to_thread.run_sync(compute)
    except ValueError as exc:
        raise BacktestValidationError(str(exc)) from exc
    result = BacktestResponse(
        id=str(uuid.uuid4()), created_at=now_ms(), status="completed", primary_symbol=primary,
        symbols=symbols, interval=request.interval, selection=request.selection,
        provider=primary_result.provider, configuration=request, summary=summary,
        matches=matches, trades=trades,
    )

    def persist():
        with session_scope() as session:
            create_backtest(session, BacktestRow(
                id=result.id, created_at=result.created_at, primary_symbol=primary, symbols=symbols,
                interval=request.interval, selection_start=request.selection.start_time,
                selection_end=request.selection.end_time, configuration_json=request.model_dump(mode="json"),
                provider=result.provider, status=result.status, summary_json=summary.model_dump(mode="json"),
            ))
            for match in matches:
                session.add(PatternMatchRow(backtest_id=result.id, **match.model_dump(exclude={"outcome", "net_return"})))
            for trade in trades:
                session.add(TradeRow(backtest_id=result.id, **trade.model_dump()))
    await anyio.to_thread.run_sync(persist)
    return result
