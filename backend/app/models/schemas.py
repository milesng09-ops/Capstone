"""Pydantic request/response schemas for the public REST API."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.models.domain import Candle, Instrument, ProviderStatus

Direction = Literal["long", "short"]
EntryType = Literal["selection_close", "next_open"]
StopLossType = Literal["percentage", "fixed_price", "pattern_extreme", "atr_multiple"]
TakeProfitType = Literal["percentage", "fixed_price", "risk_reward"]
ExitReason = Literal["stop_loss", "take_profit", "timeout", "end_of_data"]


# --------------------------------------------------------------------------
# Health / status
# --------------------------------------------------------------------------
class HealthResponse(BaseModel):
    status: str = "ok"
    provider: str
    fallback_active: bool
    database: str
    version: str
    environment: str


class ProviderStatusResponse(BaseModel):
    active_provider: str
    requested_provider: str
    fallback_active: bool
    fallback_reason: str | None = None
    massive_api_key_configured: bool
    providers: list[ProviderStatus]
    fallback_history: list["FallbackEvent"] = Field(default_factory=list)


class FallbackEvent(BaseModel):
    timestamp_ms: int
    from_provider: str
    to_provider: str
    reason: str


class SymbolsResponse(BaseModel):
    symbols: list[Instrument]


class BarsResponse(BaseModel):
    symbol: str
    interval: str
    provider: str
    cached: bool
    fallback_active: bool = False
    fallback_reason: str | None = None
    quality: str = "cached"
    rate_limited: bool = False
    retry_after_seconds: float | None = None
    bars: list[Candle]


class CacheStatsResponse(BaseModel):
    total_candles: int
    per_symbol: list["CacheSymbolStat"]
    database_path: str
    last_fetch_ms: int | None = None


class CacheSymbolStat(BaseModel):
    symbol: str
    interval: str
    candles: int
    first_time: int | None
    last_time: int | None
    provider: str | None


# --------------------------------------------------------------------------
# ICT analysis
# --------------------------------------------------------------------------
class SwingPointOut(BaseModel):
    symbol: str
    kind: Literal["high", "low"]
    time: int
    price: float
    #: Bar at which the pivot became knowable. Trading rules must use this.
    confirmed_time: int
    strength: int


class FairValueGapOut(BaseModel):
    symbol: str
    direction: Literal["bullish", "bearish"]
    time: int
    start_time: int
    end_time: int
    bottom: float
    top: float
    midpoint: float
    size: float
    size_percent: float
    mitigated: bool
    mitigated_time: int | None = None
    filled: bool
    filled_time: int | None = None
    #: 0.0 untouched .. 1.0 fully filled.
    penetration: float


class SmtDivergenceOut(BaseModel):
    kind: Literal["high", "low"]
    bias: Literal["bearish", "bullish"]
    primary_symbol: str
    reference_symbol: str
    start_time: int
    end_time: int
    primary_start_price: float
    primary_end_price: float
    reference_start_price: float
    reference_end_price: float
    leading_symbol: str
    lagging_symbol: str
    validity: Literal["swing_pair", "fvg_edge", "unconfirmed"]
    valid: bool
    confirmed_time: int
    inside_fair_value_gap: bool
    fair_value_gap_time: int | None = None
    strength: float
    separation_bars: int


class IctAnalysisResponse(BaseModel):
    symbol: str
    interval: str
    from_time: int
    to_time: int
    provider: str
    bars_analysed: int
    swing_strength: int
    reference_symbols: list[str] = Field(default_factory=list)
    swing_points: list[SwingPointOut] = Field(default_factory=list)
    fair_value_gaps: list[FairValueGapOut] = Field(default_factory=list)
    smt_divergences: list[SmtDivergenceOut] = Field(default_factory=list)
    #: Non-fatal notes: truncation, symbols that could not be compared, etc.
    warnings: list[str] = Field(default_factory=list)


# --------------------------------------------------------------------------
# Backtests
# --------------------------------------------------------------------------
class SelectionSpec(BaseModel):
    start_time: int = Field(..., description="Unix ms, inclusive")
    end_time: int = Field(..., description="Unix ms, inclusive")

    @model_validator(mode="after")
    def _check_order(self) -> "SelectionSpec":
        if self.end_time <= self.start_time:
            raise ValueError("selection.end_time must be greater than start_time")
        return self


class TradeRules(BaseModel):
    direction: Direction = "long"
    entry_type: EntryType = "selection_close"
    stop_loss_type: StopLossType = "percentage"
    stop_loss_value: float = 1.0
    take_profit_type: TakeProfitType = "risk_reward"
    take_profit_value: float = 2.0
    maximum_holding_bars: int = Field(24, ge=1, le=2000)
    fee_percent: float = Field(0.02, ge=0, le=5)
    slippage_percent: float = Field(0.01, ge=0, le=5)
    allow_overlapping_trades: bool = True
    atr_period: int = Field(14, ge=2, le=200)

    @model_validator(mode="after")
    def _check_values(self) -> "TradeRules":
        if self.stop_loss_type in {"percentage", "atr_multiple"} and self.stop_loss_value <= 0:
            raise ValueError("stop_loss_value must be greater than 0")
        if self.take_profit_type in {"percentage", "risk_reward"} and self.take_profit_value <= 0:
            raise ValueError("take_profit_value must be greater than 0")
        if self.stop_loss_type == "fixed_price" and self.stop_loss_value <= 0:
            raise ValueError("stop_loss_value must be a positive price")
        if self.take_profit_type == "fixed_price" and self.take_profit_value <= 0:
            raise ValueError("take_profit_value must be a positive price")
        return self


class DetectorFilters(BaseModel):
    """Conditions a match must meet at its entry bar to be traded at all.

    All off by default: a run that asks for nothing behaves exactly as it did
    before detectors could decide anything.
    """

    #: The entry price sat inside a fair value gap that was unfilled at the
    #: time. Containment, not mere presence -- a gap elsewhere on the chart
    #: says nothing about this entry.
    require_fair_value_gap: bool = False
    #: A valid SMT divergence had been confirmed within `within_bars`.
    require_smt_divergence: bool = False
    #: A swing point had been confirmed within `within_bars`.
    require_swing_point: bool = False
    #: How recently a swing or divergence must have been confirmed to count
    #: as this trade's reason. Does not apply to gaps, which stay live until
    #: filled however long that takes.
    within_bars: int = Field(10, ge=1, le=500)
    #: Require each detector to point the same way as the trade: a long wants
    #: a bullish gap, a bullish divergence, a swing low.
    align_with_direction: bool = True
    #: Confirmation width for swing detection, which also feeds SMT.
    swing_strength: int = Field(2, ge=1, le=20)

    @property
    def any_required(self) -> bool:
        return (
            self.require_fair_value_gap
            or self.require_smt_divergence
            or self.require_swing_point
        )


class LearningSettings(BaseModel):
    """Phase two: fit the similarity weights instead of taking them as given.

    Off by default. When on, the lookback is split in two: the weights are
    fitted on the earlier part and the backtest runs on the later part, so
    the result is never read off the data the model was chosen on.
    """

    enabled: bool = False
    #: Share of the lookback used to fit. The remainder is what the reported
    #: result is measured on, so this trades training signal against the size
    #: of the out-of-sample window.
    train_fraction: float = Field(0.5, ge=0.2, le=0.8)
    #: How many windows across the training half are used as queries.
    #:
    #: Fitting to one selection asks "which weights made *this* window's
    #: neighbours pay", which seven free parameters can answer by memorising
    #: the neighbourhood. Fitting across many asks whether similarity is
    #: predictive at all, which is both the harder question and the one worth
    #: an answer. Set to 1 to fit against the user's own selection alone,
    #: which is the narrower behaviour kept for comparison.
    query_samples: int = Field(60, ge=1, le=400)


class LearnedWeightsOut(BaseModel):
    """A fitted weight set and what it is worth.

    The whole model, in full: seven numbers between 0 and 1.
    """

    weights: dict[str, float]
    train_score: float
    #: What the hand-set weights scored on the same training windows.
    default_score: float
    #: False when the fit could not beat the defaults on its own training
    #: data, which means it found nothing.
    improved: bool
    labelled_windows: int
    #: Windows used as queries. 1 means the fit saw only the selection.
    query_windows: int = 1
    top_k: int
    passes: int
    objective: str
    dropped_blocks: list[str] = Field(default_factory=list)
    #: The same objective on windows the fit never saw. This is the figure
    #: that decides whether the model is worth anything; `improved` above is
    #: only about the data it was fitted to.
    holdout_score: float | None = None
    holdout_default_score: float | None = None
    holdout_windows: int = 0
    #: `None` when the holdout was too small to judge on.
    generalised: bool | None = None
    train_start: int
    train_end: int


class SearchSettings(BaseModel):
    lookback_start: int
    lookback_end: int
    pattern_length: int | None = Field(
        None,
        description="Number of candles the pattern is resampled to. Defaults to the selection length.",
    )
    maximum_matches: int = Field(25, ge=1, le=25)
    minimum_similarity: float = Field(0.75, ge=-1.0, le=1.0)
    #: Minimum separation between two accepted matches, in candles.
    minimum_separation_bars: int | None = None
    search_symbols: list[str] | None = None

    @model_validator(mode="after")
    def _check_range(self) -> "SearchSettings":
        if self.lookback_end <= self.lookback_start:
            raise ValueError("search.lookback_end must be greater than lookback_start")
        return self


class BacktestRequest(BaseModel):
    symbols: list[str] = Field(default_factory=lambda: ["ES", "NQ", "YM"])
    primary_symbol: str = "ES"
    interval: str = "1h"
    selection: SelectionSpec
    trade: TradeRules = Field(default_factory=TradeRules)
    search: SearchSettings
    detectors: DetectorFilters = Field(default_factory=DetectorFilters)
    learning: LearningSettings = Field(default_factory=LearningSettings)

    @model_validator(mode="after")
    def _check_symbols(self) -> "BacktestRequest":
        if self.primary_symbol not in self.symbols:
            self.symbols = [self.primary_symbol, *self.symbols]
        return self


class PatternMatchOut(BaseModel):
    id: str
    symbol: str
    interval: str
    start_time: int
    end_time: int
    similarity_score: float
    euclidean_distance: float
    entry_price: float
    rank: int
    normalized_series: list[float] | None = None
    outcome: str | None = None
    net_return: float | None = None


class TradeOut(BaseModel):
    id: str
    trade_number: int
    pattern_match_id: str
    symbol: str
    direction: Direction
    entry_time: int
    exit_time: int
    entry_price: float
    exit_price: float
    stop_price: float
    target_price: float
    gross_return: float
    fees: float
    net_return: float
    exit_reason: ExitReason
    holding_bars: int
    similarity_score: float
    same_bar_ambiguity: bool


class EquityPoint(BaseModel):
    trade_number: int
    time: int
    equity: float
    drawdown: float


class BaselineSummary(BaseModel):
    """The same trade rules run at randomly chosen windows.

    The reference point the observed win rate is read against: same candles,
    same costs, same stop and target, windows picked by chance rather than by
    resemblance.
    """

    samples: int
    trades_executed: int
    win_rate: float
    average_return: float
    expectancy: float
    #: Derived from the query, so a rerun reproduces this exact draw.
    seed: int


class BacktestSummary(BaseModel):
    total_matches: int
    trades_executed: int
    skipped_matches: int
    wins: int
    losses: int
    breakeven: int
    timeouts: int
    win_rate: float
    #: Both compounded, so the gap between them is the cost of trading rather
    #: than an artefact of one being summed and the other compounded.
    gross_return: float
    net_return: float
    average_return: float
    median_return: float
    average_winner: float
    average_loser: float
    risk_reward_achieved: float
    #: ``None`` when no trade lost, which makes the ratio undefined rather
    #: than merely large.
    profit_factor: float | None = None
    expectancy: float
    maximum_drawdown: float
    longest_winning_streak: int
    longest_losing_streak: int
    average_holding_bars: float
    #: 95% Wilson interval around ``win_rate``, in percent. Quoting the rate
    #: without it implies a precision the sample does not carry.
    win_rate_low: float = 0.0
    win_rate_high: float = 0.0
    #: What the same rules paid at windows nobody chose. ``None`` when the
    #: baseline could not be drawn -- too little history for the window.
    baseline: BaselineSummary | None = None
    #: P(a win rate at least this high | the setup has no edge over the
    #: baseline). Small means chance alone rarely does this well. It does not
    #: account for the setup being picked by eye, nor for repeated attempts on
    #: the same window; both are named in ``assumptions``.
    baseline_p_value: float | None = None
    #: Matches dropped because they did not meet the detector conditions.
    #: Separate from `skipped_matches`, which counts matches that could not be
    #: simulated at all -- a match filtered out on purpose is not a failure.
    #: Present only when weights were fitted for this run.
    learned_weights: LearnedWeightsOut | None = None
    #: Distinct configurations run against a window overlapping this one,
    #: this run included. 1 means this is the first thing tried here.
    configurations_tried: int = 1
    #: Chance that *any* of those configurations looks this good by chance.
    #: `None` when there is no baseline to compare against.
    family_wise_p_value: float | None = None
    condition_filtered_matches: int = 0
    #: One line per condition that was required, for the notes.
    conditions_applied: list[str] = Field(default_factory=list)
    sample_size_warning: str | None = None
    same_bar_ambiguity_count: int = 0
    equity_curve: list[EquityPoint] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    data_quality: list[str] = Field(default_factory=list)


class BacktestResponse(BaseModel):
    id: str
    created_at: int
    status: str
    primary_symbol: str
    symbols: list[str]
    interval: str
    selection: SelectionSpec
    provider: str
    configuration: BacktestRequest
    summary: BacktestSummary | None = None
    matches: list[PatternMatchOut] = Field(default_factory=list)
    trades: list[TradeOut] = Field(default_factory=list)
    error_message: str | None = None


class BacktestListItem(BaseModel):
    id: str
    created_at: int
    primary_symbol: str
    interval: str
    status: str
    trades_executed: int | None = None
    win_rate: float | None = None
    net_return: float | None = None


class BacktestListResponse(BaseModel):
    backtests: list[BacktestListItem]


class TradesResponse(BaseModel):
    backtest_id: str
    trades: list[TradeOut]


class MessageResponse(BaseModel):
    message: str
    detail: str | None = None


ProviderStatusResponse.model_rebuild()
CacheStatsResponse.model_rebuild()
