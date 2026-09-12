"""Application configuration.

All configuration comes from environment variables (optionally via a ``.env``
file at the repository root).  Nothing in here is ever sent to the browser --
provider credentials stay server side.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent
DEFAULT_DEMO_DIR = REPO_ROOT / "data" / "demo"
DEFAULT_DB_PATH = BACKEND_DIR / "var" / "market_replay_lab.db"

ProviderName = Literal["auto", "massive", "yahoo", "demo"]


class Settings(BaseSettings):
    """Runtime settings for the backend."""

    model_config = SettingsConfigDict(
        env_file=(REPO_ROOT / ".env", BACKEND_DIR / ".env"),
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # ---- Providers -------------------------------------------------------
    massive_api_key: str = ""
    #: Massive puts the API version inside each path (``/futures/v1/aggs``),
    #: so this is the bare host.
    massive_base_url: str = "https://api.massive.com"
    data_provider: ProviderName = "auto"

    #: Seconds a provider stays marked unhealthy after a failure before we
    #: retry it.  Prevents hammering a provider that is down or unauthorised.
    provider_health_ttl_seconds: int = 120
    #: Longer cool-off for permanent problems such as a missing API key.
    provider_health_permanent_ttl_seconds: int = 900
    provider_timeout_seconds: float = 20.0
    provider_max_retries: int = 3

    #: Massive's published quota.  Enforced on our side as well, because going
    #: over costs a two-minute health cool-off rather than just the one
    #: rejected call -- so the sixth request in a minute is worth not sending.
    massive_max_requests_per_minute: int = 5
    #: How long a request will wait for a free slot before giving up and
    #: letting the chain fall through to Yahoo.
    #:
    #: One full window, because that is the point at which waiting stops being
    #: a gamble: with a sliding window, a slot is *guaranteed* to open within
    #: ``60s`` of the oldest call, so anything short of that gives up on a
    #: request it could have served.  The cost is a bars request that can sit
    #: for up to a minute, which is the trade being made deliberately --
    #: queueing for the preferred provider rather than quietly switching
    #: source mid-session.  Lower it to favour a fast answer from Yahoo over a
    #: slow one from Massive.
    massive_throttle_max_wait_seconds: float = 60.0

    # ---- Storage ---------------------------------------------------------
    database_url: str = ""
    demo_data_dir: str = str(DEFAULT_DEMO_DIR)

    # ---- Limits (cost controls) -----------------------------------------
    max_symbols_per_workspace: int = 3
    max_bars_per_request: int = 20_000
    #: Shortest gap between two fetches of the same series' forming tail.
    #:
    #: One view of one market is several requests -- the candles, and the
    #: detections, which fetch the correlated market too for SMT.  A two-chart
    #: workspace therefore asks for six series on every change of timeframe,
    #: and each one used to poke the provider for the tail, because the tail is
    #: never recorded as covered.  Against a quota of five calls a minute that
    #: is more than a minute's budget for a single click.
    #:
    #: Shorter than the client's own 60-second staleness window, so it
    #: collapses the requests that make up one view without ever delaying a
    #: refresh the user would otherwise have seen.
    fresh_tail_min_seconds: float = 15.0
    max_intraday_history_days: int = 730
    max_pattern_matches: int = 25
    max_candidate_windows: int = 250_000
    min_pattern_length: int = 5
    max_pattern_length: int = 400

    # ---- ICT analysis ----------------------------------------------------
    #: Detectors happily produce thousands of objects over a long lookback.
    #: These caps keep the JSON response and the chart overlay manageable by
    #: returning the most recent items.
    default_swing_strength: int = 2
    max_swing_points: int = 600
    max_fair_value_gaps: int = 400
    max_smt_divergences: int = 200

    # ---- Server ----------------------------------------------------------
    cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"
    environment: Literal["development", "production"] = "development"
    log_level: str = "INFO"

    @property
    def resolved_database_url(self) -> str:
        if self.database_url:
            return self.database_url
        DEFAULT_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
        return f"sqlite:///{DEFAULT_DB_PATH.as_posix()}"

    @property
    def demo_dir(self) -> Path:
        return Path(self.demo_data_dir)

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def is_development(self) -> bool:
        return self.environment == "development"

    @property
    def massive_api_key_configured(self) -> bool:
        return bool(self.massive_api_key.strip())


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()


def reset_settings_cache() -> None:
    """Used by the test-suite when environment variables are patched."""

    get_settings.cache_clear()
    os.environ.pop("__MRL_SETTINGS_CACHE__", None)
