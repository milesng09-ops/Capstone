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


class BacktestSummary(BaseModel):
    total_matches: int
    trades_executed: int
    skipped_matches: int
    wins: int
    losses: int
    breakeven: int
    timeouts: int
    win_rate: float
    gross_return: float
    net_return: float
    average_return: float
    median_return: float
    average_winner: float
    average_loser: float
    risk_reward_achieved: float
    profit_factor: float
    expectancy: float
    maximum_drawdown: float
    longest_winning_streak: int
    longest_losing_streak: int
    average_holding_bars: float
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
