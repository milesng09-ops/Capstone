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
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass

import anyio
from pydantic import ValidationError

from app.analysis import find_fair_value_gaps, find_smt_divergences, find_swing_points
from app.analysis.conditions import detectors_at_entry, unmet_condition
from app.backtesting.engine import BacktestEngine, MatchInput, SimulatedTrade, entry_bar
from app.backtesting.attempts import configuration_key
from app.backtesting.metrics import compute_metrics
from app.backtesting.significance import (
    BASELINE_OVERSAMPLE,
    DEFAULT_BASELINE_SAMPLES,
    baseline_inputs,
    baseline_seed,
    run_baseline,
    summarise_baseline,
)
from app.config import get_settings
from app.database.repository import (
    configurations_against_selection,
    create_backtest,
    get_matches,
    get_trades,
)
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

        # ---- detector conditions --------------------------------------
        # Computed once per symbol and consulted per match, always as of the
        # bar the trade enters on.
        detectors = self._detector_context(request, usable, primary)
        within_ms = request.detectors.within_bars * interval_ms(interval)
        filtered_total = 0
        if request.detectors.any_required:
            kept: dict[str, list] = {}
            for symbol, entries in by_symbol.items():
                candles = series_by_symbol[symbol].candles
                for match_id, window in entries:
                    reason = self._condition_reason(
                        candles=candles,
                        end_index=window.end_index,
                        request=request,
                        context=detectors.get(symbol),
                        within_ms=within_ms,
                    )
                    if reason is None:
                        kept.setdefault(symbol, []).append((match_id, window))
                    else:
                        filtered_total += 1
                        logger.info("Match %s dropped: %s", match_id, reason)
            by_symbol = kept

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

        # ---- null baseline --------------------------------------------
        # The same rules at windows drawn by chance rather than resemblance,
        # so the win rate above has something to be read against.
        baseline = await anyio.to_thread.run_sync(
            lambda: self._draw_baseline(
                request=request,
                query_length=query.length,
                required_future_bars=required_future_bars,
                exclusion=exclusion,
                primary=primary,
                by_symbol=by_symbol,
                series_by_symbol=series_by_symbol,
                detectors=detectors,
                within_ms=within_ms,
            )
        )

        # ---- how many times this window has been asked ----------------
        # Counted before this run is written, then this configuration added,
        # so a rerun of something already tried does not inflate the tally.
        configurations = await anyio.to_thread.run_sync(
            lambda: self._configurations_tried(request)
        )

        summary = compute_metrics(
            all_trades,
            total_matches=len(found),
            skipped_matches=skipped_total,
            data_quality=self._data_quality_notes(series, usable, query, interval),
            extra_assumptions=self._extra_assumptions(query, request),
            baseline=baseline,
            condition_filtered_matches=filtered_total,
            conditions_applied=self._conditions_applied(request),
            configurations_tried=configurations,
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
        series: list[_SymbolSeries],
        usable: list[_SymbolSeries],
        query,
        interval: str,
    ) -> list[str]:
        notes: list[str] = []
        providers = sorted({item.provider for item in series})
        notes.append(f"Data provider: {', '.join(providers)}.")

        # Keyed on what the candles *are*, not on who served them last. A
        # window can hold generated bars left by an earlier outage while the
        # provider name reads "yahoo", and that is exactly the run whose win
        # rate must not look measured.
        if any(item.quality == "demo" for item in series):
            notes.append(
                "Demo data is synthetic and generated from a fixed seed. "
                "It is not actual market data."
            )
        # Over every series fetched, not only the ones long enough to search:
        # a symbol dropped for a short fetch is the strongest evidence that
        # the window was incomplete, and it is exactly the one that would be
        # missing from a list of what got used.
        if any(item.quality == "partial" for item in series):
            notes.append(
                "Part of the requested history could not be fetched, so this run "
                "searched fewer candles than the window asked for. Reload the range "
                "once the provider recovers and run it again before trusting the "
                "win rate."
            )
        searched = {item.symbol for item in usable}
        for item in series:
            if item.symbol in searched:
                notes.append(
                    f"{item.symbol}: {len(item.candles):,} {interval} candles used for the "
                    "search."
                )
            else:
                # Dropped for holding too few candles. Saying so matters more
                # than the ones that worked: a run quietly measured on one
                # market instead of two is not the run that was asked for.
                notes.append(
                    f"{item.symbol}: only {len(item.candles):,} {interval} candles were "
                    "available, too few to search, so this market was left out of the run."
                )
            if item.fallback_reason:
                notes.append(f"{item.symbol}: {item.fallback_reason}")
        notes.append(
            "Futures series are indicative continuous front-contract data and are not "
            "roll-adjusted; prices around contract rolls may jump."
        )
        return notes

    # ------------------------------------------------------------------
    def _detector_context(self, request: BacktestRequest, usable, primary: str) -> dict:
        """Swings, gaps and divergences per symbol, computed once.

        Empty when nothing is required, so a run that asks for no conditions
        pays nothing for the machinery.
        """

        if not request.detectors.any_required:
            return {}

        strength = request.detectors.swing_strength
        swings_by_symbol = {}
        gaps_by_symbol = {}
        for item in usable:
            swings_by_symbol[item.symbol] = find_swing_points(
                item.candles, strength=strength
            )
            gaps_by_symbol[item.symbol] = find_fair_value_gaps(item.candles)

        context: dict = {}
        for item in usable:
            # SMT is a comparison, so it needs a partner. The primary is
            # measured against the first other series; the others against the
            # primary. With nothing to compare to there are no divergences,
            # and a run requiring them will correctly find nothing.
            reference = next(
                (
                    other
                    for other in usable
                    if other.symbol != item.symbol
                    and (item.symbol == primary or other.symbol == primary)
                ),
                None,
            )
            divergences = []
            if reference is not None and request.detectors.require_smt_divergence:
                divergences = find_smt_divergences(
                    item.candles,
                    swings_by_symbol[item.symbol],
                    reference.candles,
                    swings_by_symbol[reference.symbol],
                    primary_gaps=gaps_by_symbol[item.symbol],
                    reference_gaps=gaps_by_symbol[reference.symbol],
                )
            context[item.symbol] = {
                "gaps": gaps_by_symbol[item.symbol],
                "swings": swings_by_symbol[item.symbol],
                "divergences": divergences,
            }
        return context

    def _condition_reason(
        self, *, candles, end_index: int, request: BacktestRequest, context, within_ms: int
    ) -> str | None:
        """Why this match cannot be traded, or ``None`` if it can.

        The entry bar comes from the engine's own helper, so the conditions
        are read at exactly the bar the simulation would open on.
        """

        if context is None:
            return "No detector analysis was available for this symbol."

        entry = entry_bar(candles, end_index, request.trade)
        if entry is None:
            # The engine will skip it for the same reason; let it say so.
            return None
        entry_index, entry_price = entry

        state = detectors_at_entry(
            entry_price=entry_price,
            entry_time=candles[entry_index].time,
            direction=request.trade.direction,
            gaps=context["gaps"],
            swings=context["swings"],
            divergences=context["divergences"],
            within_ms=within_ms,
            align_with_direction=request.detectors.align_with_direction,
        )
        return unmet_condition(
            state,
            require_fair_value_gap=request.detectors.require_fair_value_gap,
            require_smt_divergence=request.detectors.require_smt_divergence,
            require_swing_point=request.detectors.require_swing_point,
        )

    @staticmethod
    def _conditions_applied(request: BacktestRequest) -> list[str]:
        """One line per condition, for the notes tab."""

        filters = request.detectors
        if not filters.any_required:
            return []

        aligned = (
            " pointing the same way as the trade"
            if filters.align_with_direction
            else " in either direction"
        )
        lines: list[str] = []
        if filters.require_fair_value_gap:
            lines.append(
                f"Only matches whose entry price sat inside an unfilled fair value gap{aligned}."
            )
        if filters.require_smt_divergence:
            lines.append(
                f"Only matches with a valid SMT divergence{aligned} confirmed within "
                f"{filters.within_bars} bars before entry."
            )
        if filters.require_swing_point:
            lines.append(
                f"Only matches with a swing point{aligned} confirmed within "
                f"{filters.within_bars} bars before entry."
            )
        lines.append(
            "Conditions are read at the entry bar using only what had been confirmed "
            "by then, and the random-entry baseline is held to the same conditions."
        )
        return lines

    def _configurations_tried(self, request: BacktestRequest) -> int:
        """Distinct configurations run against a window overlapping this one.

        Includes this one, so the first run of a fresh window reports 1.
        Rerunning something already tried does not move the number: the search
        is deterministic, so it is the same draw at the same question, not a
        new one.
        """

        with session_scope() as session:
            prior = configurations_against_selection(
                session,
                primary_symbol=request.primary_symbol,
                interval=request.interval,
                selection_start=request.selection.start_time,
                selection_end=request.selection.end_time,
            )

        keys = set()
        for payload in prior:
            try:
                keys.add(configuration_key(BacktestRequest.model_validate(payload)))
            except ValidationError:
                # A run recorded under an older shape of the request. It was
                # still an attempt at this window, so it counts -- identified
                # by the payload itself rather than dropped for not parsing.
                keys.add(
                    hashlib.sha256(
                        json.dumps(payload, sort_keys=True, default=str).encode("utf-8")
                    ).hexdigest()[:32]
                )

        keys.add(configuration_key(request))
        return len(keys)

    def _draw_baseline(
        self,
        *,
        request: BacktestRequest,
        query_length: int,
        required_future_bars: int,
        exclusion: tuple[int, int],
        primary: str,
        by_symbol: dict,
        series_by_symbol: dict,
        detectors: dict,
        within_ms: int,
    ):
        """The same rules at windows chosen by chance, pooled across symbols.

        Draws are apportioned to each symbol by the share of matches it
        contributed, so the null is sampled from the same mix of series the
        matches came from.  A baseline drawn only from the primary would be a
        different opportunity set whenever the reference symbol supplied any
        of the matches.

        The seed is derived from the selection and the rules, so the same
        backtest reproduces the same baseline.  It is reported alongside the
        figures for exactly that reason.

        Detector conditions apply here too.  If a run only takes matches that
        sat inside a fair value gap, a baseline free to enter anywhere would
        no longer be measuring what the similarity search contributed -- it
        would be measuring the conditions and the search together, and the
        gap between them would credit the search for both.  Holding the
        conditions constant on both sides leaves resemblance as the only
        difference, which is the whole point of the comparison.
        """

        matched_total = sum(len(entries) for entries in by_symbol.values())
        if not matched_total:
            return None

        seed = baseline_seed(
            request.selection.start_time,
            request.selection.end_time,
            request.interval,
            primary,
            query_length,
            request.trade.model_dump_json(),
        )

        trades = []
        drawn = 0
        for symbol, entries in by_symbol.items():
            share = len(entries) / matched_total
            samples = max(1, round(DEFAULT_BASELINE_SAMPLES * share))
            candles = series_by_symbol[symbol].candles
            # Conditions reject most windows by design, so oversample when
            # they are on: filtering 500 draws down to a handful would leave
            # a baseline too noisy to read against anything.
            draw = samples * BASELINE_OVERSAMPLE if request.detectors.any_required else samples
            inputs = baseline_inputs(
                candles,
                window_length=query_length,
                # Only the primary series holds the selection, so only it has
                # a region to keep the baseline out of -- the same rule the
                # search applies when it builds `exclude`.
                exclude_ranges=[exclusion] if symbol == primary else [],
                required_future_bars=required_future_bars,
                samples=draw,
                seed=seed,
            )
            if request.detectors.any_required:
                inputs = [
                    item
                    for item in inputs
                    if self._condition_reason(
                        candles=candles,
                        end_index=item.end_index,
                        request=request,
                        context=detectors.get(symbol),
                        within_ms=within_ms,
                    )
                    is None
                ][:samples]
            drawn += len(inputs)
            trades.extend(run_baseline(candles, request.trade, inputs))

        # `samples` reports what was actually offered to the engine, not the
        # nominal target: with conditions on, the two differ and the smaller
        # number is the honest denominator.
        return summarise_baseline(trades, samples=drawn, seed=seed)

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
