"""In-process provider health tracking.

Prevents the fallback chain from calling a provider we already know is broken
on every single request, and gives the UI a readable fallback history.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass

from app.config import get_settings
from app.utils.timeutils import now_ms

logger = logging.getLogger(__name__)

MAX_HISTORY = 25


@dataclass
class HealthEntry:
    healthy: bool = True
    last_error: str | None = None
    last_checked_ms: int | None = None
    cooldown_until_ms: int | None = None
    failure_count: int = 0
    #: Whether the current cool-off was caused by a quota rejection rather
    #: than an outage. The UI phrases the two differently -- one is "wait",
    #: the other is "something is wrong" -- and it should not have to infer
    #: which by pattern-matching on ``last_error``.
    rate_limited: bool = False


@dataclass
class FallbackRecord:
    timestamp_ms: int
    from_provider: str
    to_provider: str
    reason: str


class ProviderHealthRegistry:
    """Thread-safe health state shared by every request."""

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._entries: dict[str, HealthEntry] = {}
        self._history: list[FallbackRecord] = []

    def entry(self, provider: str) -> HealthEntry:
        with self._lock:
            return self._entries.setdefault(provider, HealthEntry())

    def is_available(self, provider: str) -> bool:
        """False while the provider is inside its failure cool-off window."""

        with self._lock:
            entry = self._entries.get(provider)
            if entry is None or entry.healthy:
                return True
            if entry.cooldown_until_ms is None:
                return True
            if now_ms() >= entry.cooldown_until_ms:
                # Cool-off expired: allow one probe.
                entry.healthy = True
                entry.cooldown_until_ms = None
                logger.info("Provider '%s' cool-off expired, will retry", provider)
                return True
            return False

    def mark_success(self, provider: str) -> None:
        with self._lock:
            entry = self._entries.setdefault(provider, HealthEntry())
            was_unhealthy = not entry.healthy
            entry.healthy = True
            entry.last_error = None
            entry.cooldown_until_ms = None
            entry.failure_count = 0
            entry.rate_limited = False
            entry.last_checked_ms = now_ms()
            if was_unhealthy:
                logger.info("Provider '%s' recovered", provider)

    def mark_failure(
        self,
        provider: str,
        reason: str,
        permanent: bool = False,
        rate_limited: bool = False,
    ) -> None:
        settings = get_settings()
        ttl = (
            settings.provider_health_permanent_ttl_seconds
            if permanent
            else settings.provider_health_ttl_seconds
        )
        with self._lock:
            entry = self._entries.setdefault(provider, HealthEntry())
            entry.healthy = False
            entry.last_error = reason
            entry.rate_limited = rate_limited
            entry.failure_count += 1
            entry.last_checked_ms = now_ms()
            entry.cooldown_until_ms = now_ms() + ttl * 1000
        logger.warning(
            "Provider '%s' marked unhealthy for %ss: %s", provider, ttl, reason
        )

    def note_throttled(self, provider: str, retry_after_seconds: float) -> None:
        """Record that *we* paced a provider, rather than it rejecting us.

        Deliberately leaves ``healthy`` alone. Marking a provider unhealthy
        here would be self-defeating: the throttle exists to avoid the
        two-minute cool-off a 429 costs, and imposing that cool-off ourselves
        would buy the whole penalty while skipping the request that at least
        might have worked. The deadline is still published so the UI can show
        a countdown -- a short one, measured in seconds rather than minutes.
        """

        with self._lock:
            entry = self._entries.setdefault(provider, HealthEntry())
            entry.rate_limited = True
            entry.last_error = (
                f"Pacing requests to stay under the quota; next slot in "
                f"{retry_after_seconds:.0f}s"
            )
            entry.last_checked_ms = now_ms()
            entry.cooldown_until_ms = now_ms() + int(max(0.0, retry_after_seconds) * 1000)

    def record_fallback(self, from_provider: str, to_provider: str, reason: str) -> None:
        with self._lock:
            self._history.append(
                FallbackRecord(now_ms(), from_provider, to_provider, reason)
            )
            del self._history[:-MAX_HISTORY]
        logger.info("%s unavailable: %s. Switching to %s.", from_provider, reason, to_provider)

    def history(self) -> list[FallbackRecord]:
        with self._lock:
            return list(reversed(self._history))

    def snapshot(self) -> dict[str, HealthEntry]:
        with self._lock:
            return {key: HealthEntry(**vars(value)) for key, value in self._entries.items()}

    def reset(self) -> None:
        with self._lock:
            self._entries.clear()
            self._history.clear()


_registry = ProviderHealthRegistry()


def get_health_registry() -> ProviderHealthRegistry:
    return _registry
