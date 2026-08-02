"""Backtest orchestration.

Ties together the candle service, the deterministic pattern search and the
event-based engine, then persists everything so results can be reloaded and
inspected trade by trade.

Concurrency: one active backtest per session (identified by the
``X-Session-Id`` header).  A second request while one is running is rejected
rather than queued, which keeps server load predictable.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from dataclasses import dataclass

import anyio

from app.backtesting.engine import BacktestEngine, MatchInput, SimulatedTrade
from app.backtesting.metrics import compute_metrics
from app.config import get_settings
from app.database.repository import create_backtest, get_matches, get_trades
from app.database.session import session_scope
from app.models.db_models import BacktestRow, PatternMatchRow, TradeRow
from app.models.domain import Candle
from app.models.schemas import (
    BacktestRequest,
    BacktestResponse,
    BacktestSummary,
    PatternMatchOut,
    SelectionSpec,
    TradeOut,
)
from app.providers.instruments import get_instrument
from app.services.candle_service import CandleService, get_candle_service
from app.services.pattern_service import (
    PatternError,
    PatternWindow,
    build_query,
    find_similar_windows,
)
from app.utils.intervals import interval_ms
from app.utils.timeutils import now_ms

logger = logging.getLogger(__name__)


class BacktestValidationError(ValueError):
    """The request cannot be run as configured."""


class BacktestBusyError(RuntimeError):
    """A backtest is already running for this session."""


@dataclass
class _SymbolSeries:
    symbol: str
    candles: list[Candle]
    provider: str
    quality: str
    fallback_reason: str | None


class BacktestService:
    def __init__(self, candle_service: CandleService | None = None) -> None:
        self._candles = candle_service or get_candle_service()
        self._active_sessions: set[str] = set()
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------
    async def run(self, request: BacktestRequest, session_id: str) -> BacktestResponse:
        async with self._lock:
            if session_id in self._active_sessions:
                raise BacktestBusyError(
                    "A backtest is already running for this session. "
                    "Wait for it to finish before starting another."
                )
            self._active_sessions.add(session_id)
        try:
            return await self._run(request)
        finally:
            async with self._lock:
                self._active_sessions.discard(session_id)

    # ------------------------------------------------------------------
    async def _run(self, request: BacktestRequest) -> BacktestResponse:
        settings = get_settings()
        self._validate(request, settings)

        interval = request.interval
        primary = get_instrument(request.primary_symbol).symbol
        search_symbols = [
            get_instrument(symbol).symbol
            for symbol in (request.search.search_symbols or request.symbols)
        ]
        if primary not in search_symbols:
            search_symbols.insert(0, primary)
        search_symbols = list(dict.fromkeys(search_symbols))[
            : settings.max_symbols_per_workspace
        ]

        # ---- selected setup ------------------------------------------
        selection_result = await self._candles.get_series_for_analysis(
            primary, interval, request.selection.start_time, request.selection.end_time
        )
        selection_candles = selection_result.bars
        if len(selection_candles) < settings.min_pattern_length:
            raise BacktestValidationError(
                f"The selected period contains {len(selection_candles)} candles on the "
                f"{interval} interval. At least {settings.min_pattern_length} are required."
            )

        try:
            query = build_query(
                selection_candles,
                interval,
                request.search.pattern_length,
                min_length=settings.min_pattern_length,
                max_length=settings.max_pattern_length,
            )
        except PatternError as exc:
            raise BacktestValidationError(str(exc)) from exc

        # ---- lookback series -----------------------------------------
        required_future_bars = request.trade.maximum_holding_bars + 2
        series: list[_SymbolSeries] = []
        for symbol in search_symbols:
            # The chunked reader is used because a lookback window is routinely
            # larger than the per-request bar cap that protects the chart API.
            result = await self._candles.get_series_for_analysis(
                symbol,
                interval,
                request.search.lookback_start,
                request.search.lookback_end,
            )
            series.append(
                _SymbolSeries(
                    symbol=symbol,
                    candles=result.bars,
                    provider=result.provider,
                    quality=result.quality,
                    fallback_reason=result.fallback_reason,
                )
            )

        usable = [item for item in series if len(item.candles) >= query.length + required_future_bars]
        if not usable:
            raise BacktestValidationError(
                "The lookback range does not contain enough candles to test this pattern. "
                "Widen the lookback range or reduce the maximum holding period."
            )

        # ---- deterministic similarity search --------------------------
        exclusion = (request.selection.start_time, request.selection.end_time)
        found: list[tuple[_SymbolSeries, PatternWindow]] = []
        for item in usable:
            exclude = [exclusion] if item.symbol == primary else []
            try:
                windows = await anyio.to_thread.run_sync(
                    lambda item=item, exclude=exclude: find_similar_windows(
                        query,
                        item.candles,
                        interval,
                        exclude_ranges=exclude,
                        minimum_similarity=request.search.minimum_similarity,
                        maximum_matches=request.search.maximum_matches,
                        minimum_separation_bars=request.search.minimum_separation_bars,
                        required_future_bars=required_future_bars,
                        max_candidate_windows=settings.max_candidate_windows,
                    )
                )
            except PatternError as exc:
                raise BacktestValidationError(str(exc)) from exc
            found.extend((item, window) for window in windows)

        found.sort(key=lambda pair: -pair[1].similarity)
        found = found[: min(request.search.maximum_matches, settings.max_pattern_matches)]

        # ---- simulate -------------------------------------------------
        match_ids: dict[int, str] = {}
        by_symbol: dict[str, list[tuple[str, PatternWindow]]] = {}
        for index, (item, window) in enumerate(found):
            match_id = str(uuid.uuid4())
            match_ids[index] = match_id
            by_symbol.setdefault(item.symbol, []).append((match_id, window))

        series_by_symbol = {item.symbol: item for item in usable}
        all_trades: list[SimulatedTrade] = []
        skipped_total = 0

        for symbol, entries in by_symbol.items():
            engine = BacktestEngine(series_by_symbol[symbol].candles, request.trade)
            inputs = [
                MatchInput(
                    id=match_id,
                    start_index=window.start_index,
                    end_index=window.end_index,
                    similarity=window.similarity,
                )
                for match_id, window in entries
            ]
            trades, skipped = await anyio.to_thread.run_sync(engine.run, inputs)
            all_trades.extend(trades)
            skipped_total += len(skipped)
            for record in skipped:
                logger.info("Skipped match %s: %s", record.pattern_match_id, record.reason)

        all_trades.sort(key=lambda trade: trade.entry_time)

        summary = compute_metrics(
            all_trades,
            total_matches=len(found),
            skipped_matches=skipped_total,
            data_quality=self._data_quality_notes(usable, query, interval),
            extra_assumptions=self._extra_assumptions(query, request),
        )

        # ---- persist ---------------------------------------------------
        backtest_id = str(uuid.uuid4())
        provider_name = usable[0].provider
        trade_returns = {trade.pattern_match_id: trade for trade in all_trades}

        def _persist() -> None:
            with session_scope() as session:
                row = BacktestRow(
                    id=backtest_id,
                    created_at=now_ms(),
                    primary_symbol=primary,
                    symbols=search_symbols,
                    interval=interval,
                    selection_start=request.selection.start_time,
                    selection_end=request.selection.end_time,
                    configuration_json=request.model_dump(mode="json"),
                    provider=provider_name,
                    status="completed",
                    summary_json=summary.model_dump(mode="json"),
                )
                create_backtest(session, row)

                for rank, (item, window) in enumerate(found):
                    session.add(
                        PatternMatchRow(
                            id=match_ids[rank],
                            backtest_id=backtest_id,
                            symbol=item.symbol,
                            interval=interval,
                            start_time=window.start_time,
                            end_time=window.end_time,
                            similarity_score=window.similarity,
                            euclidean_distance=window.euclidean_distance,
                            entry_price=window.entry_price,
                            rank=rank + 1,
                            normalized_series=window.normalized_series,
                        )
                    )

                for number, trade in enumerate(all_trades, start=1):
                    session.add(
                        TradeRow(
                            id=str(uuid.uuid4()),
                            backtest_id=backtest_id,
                            pattern_match_id=trade.pattern_match_id,
                            trade_number=number,
                            symbol=trade.symbol,
                            direction=trade.direction,
                            entry_time=trade.entry_time,
                            exit_time=trade.exit_time,
                            entry_price=trade.entry_price,
                            exit_price=trade.exit_price,
                            stop_price=trade.stop_price,
                            target_price=trade.target_price,
                            gross_return=trade.gross_return,
                            fees=trade.fees,
                            net_return=trade.net_return,
                            exit_reason=trade.exit_reason,
                            holding_bars=trade.holding_bars,
                            similarity_score=trade.similarity_score,
                            same_bar_ambiguity=trade.same_bar_ambiguity,
                        )
                    )

        await anyio.to_thread.run_sync(_persist)

        matches_out = [
            PatternMatchOut(
                id=match_ids[rank],
                symbol=item.symbol,
                interval=interval,
                start_time=window.start_time,
                end_time=window.end_time,
                similarity_score=round(window.similarity, 6),
                euclidean_distance=round(window.euclidean_distance, 6),
                entry_price=window.entry_price,
                rank=rank + 1,
                normalized_series=window.normalized_series,
                outcome=(
                    trade_returns[match_ids[rank]].exit_reason
                    if match_ids[rank] in trade_returns
                    else "not_traded"
                ),
                net_return=(
                    trade_returns[match_ids[rank]].net_return
                    if match_ids[rank] in trade_returns
                    else None
                ),
            )
            for rank, (item, window) in enumerate(found)
        ]

        return BacktestResponse(
            id=backtest_id,
            created_at=now_ms(),
            status="completed",
            primary_symbol=primary,
            symbols=search_symbols,
            interval=interval,
            selection=request.selection,
            provider=provider_name,
            configuration=request,
            summary=summary,
            matches=matches_out,
            trades=[_trade_out(index, trade) for index, trade in enumerate(all_trades, start=1)],
        )

    # ------------------------------------------------------------------
    def _validate(self, request: BacktestRequest, settings) -> None:
        if len(request.symbols) > settings.max_symbols_per_workspace:
            raise BacktestValidationError(
                f"A workspace supports at most {settings.max_symbols_per_workspace} symbols."
            )
        if request.search.maximum_matches > settings.max_pattern_matches:
            raise BacktestValidationError(
                f"At most {settings.max_pattern_matches} matches can be requested."
            )
        if request.search.lookback_end > request.selection.start_time:
            # Overlap is allowed (the selection is excluded explicitly), but a
            # lookback that starts after the selection ends is a mistake.
            pass
        span = request.selection.end_time - request.selection.start_time
        if span < interval_ms(request.interval) * settings.min_pattern_length:
            raise BacktestValidationError(
                "The selected period is too short for the chosen interval. "
                "Select a wider range or switch to a smaller interval."
            )

    @staticmethod
    def _data_quality_notes(
        series: list[_SymbolSeries], query, interval: str
    ) -> list[str]:
        notes: list[str] = []
        providers = sorted({item.provider for item in series})
        notes.append(f"Data provider: {', '.join(providers)}.")
        if "demo" in providers:
            notes.append(
                "Demo data is synthetic and generated from a fixed seed. "
                "It is not actual market data."
            )
        for item in series:
            notes.append(
                f"{item.symbol}: {len(item.candles):,} {interval} candles used for the search."
            )
            if item.fallback_reason:
                notes.append(f"{item.symbol}: {item.fallback_reason}")
        notes.append(
            "Futures series are indicative continuous front-contract data and are not "
            "roll-adjusted; prices around contract rolls may jump."
        )
        return notes

    @staticmethod
    def _extra_assumptions(query, request: BacktestRequest) -> list[str]:
        notes: list[str] = []
        if query.resampled:
            notes.append(
                f"The selection was resampled to {query.length} candles so that all "
                "compared windows have the same length."
            )
        if request.trade.allow_overlapping_trades:
            notes.append(
                "Overlapping trades are allowed, so several positions can be open at once."
            )
        else:
            notes.append(
                "Overlapping trades are disabled: a match that starts before the previous "
                "trade exits is skipped."
            )
        return notes

    # ------------------------------------------------------------------
    async def load(self, backtest_id: str) -> BacktestResponse | None:
        def _load() -> BacktestResponse | None:
            with session_scope() as session:
                from app.database.repository import get_backtest

                row = get_backtest(session, backtest_id)
                if row is None:
                    return None
                match_rows = get_matches(session, backtest_id)
                trade_rows = get_trades(session, backtest_id)
                trades_by_match = {trade.pattern_match_id: trade for trade in trade_rows}

                return BacktestResponse(
                    id=row.id,
                    created_at=row.created_at,
                    status=row.status,
                    primary_symbol=row.primary_symbol,
                    symbols=list(row.symbols or []),
                    interval=row.interval,
                    selection=SelectionSpec(
                        start_time=row.selection_start, end_time=row.selection_end
                    ),
                    provider=row.provider,
                    configuration=BacktestRequest.model_validate(row.configuration_json),
                    summary=(
                        BacktestSummary.model_validate(row.summary_json)
                        if row.summary_json
                        else None
                    ),
                    matches=[
                        PatternMatchOut(
                            id=match.id,
                            symbol=match.symbol,
                            interval=match.interval,
                            start_time=match.start_time,
                            end_time=match.end_time,
                            similarity_score=match.similarity_score,
                            euclidean_distance=match.euclidean_distance,
                            entry_price=match.entry_price,
                            rank=match.rank,
                            normalized_series=match.normalized_series,
                            outcome=(
                                trades_by_match[match.id].exit_reason
                                if match.id in trades_by_match
                                else "not_traded"
                            ),
                            net_return=(
                                trades_by_match[match.id].net_return
                                if match.id in trades_by_match
                                else None
                            ),
                        )
                        for match in match_rows
                    ],
                    trades=[
                        TradeOut(
                            id=trade.id,
                            trade_number=trade.trade_number,
                            pattern_match_id=trade.pattern_match_id,
                            symbol=trade.symbol,
                            direction=trade.direction,  # type: ignore[arg-type]
                            entry_time=trade.entry_time,
                            exit_time=trade.exit_time,
                            entry_price=trade.entry_price,
                            exit_price=trade.exit_price,
                            stop_price=trade.stop_price,
                            target_price=trade.target_price,
                            gross_return=trade.gross_return,
                            fees=trade.fees,
                            net_return=trade.net_return,
                            exit_reason=trade.exit_reason,  # type: ignore[arg-type]
                            holding_bars=trade.holding_bars,
                            similarity_score=trade.similarity_score,
                            same_bar_ambiguity=trade.same_bar_ambiguity,
                        )
                        for trade in trade_rows
                    ],
                )

        return await anyio.to_thread.run_sync(_load)


def _trade_out(number: int, trade: SimulatedTrade) -> TradeOut:
    return TradeOut(
        id=f"{trade.pattern_match_id}-{number}",
        trade_number=number,
        pattern_match_id=trade.pattern_match_id,
        symbol=trade.symbol,
        direction=trade.direction,  # type: ignore[arg-type]
        entry_time=trade.entry_time,
        exit_time=trade.exit_time,
        entry_price=trade.entry_price,
        exit_price=trade.exit_price,
        stop_price=trade.stop_price,
        target_price=trade.target_price,
        gross_return=trade.gross_return,
        fees=trade.fees,
        net_return=trade.net_return,
        exit_reason=trade.exit_reason,  # type: ignore[arg-type]
        holding_bars=trade.holding_bars,
        similarity_score=trade.similarity_score,
        same_bar_ambiguity=trade.same_bar_ambiguity,
    )


_service: BacktestService | None = None


def get_backtest_service() -> BacktestService:
    global _service
    if _service is None:
        _service = BacktestService()
    return _service
