"""Request-local policy; a GXT run must not change chart/provider behavior."""
from contextvars import ContextVar

cached_massive_on_limit: ContextVar[bool] = ContextVar('cached_massive_on_limit', default=False)
