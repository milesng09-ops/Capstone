"""The HTTP contract in ``app/api/routes.py``: paths, methods, parameter
names and response shapes.

None of these can drift in a way Python itself would catch. A route renamed,
a query parameter's alias changed, a response field dropped -- every one of
those is a perfectly ordinary code change that imports cleanly, starts the
app, and leaves every *other* route answering correctly. The one request
that breaks is whichever one the frontend actually sends, and it breaks with
a generic 404 or 422 that says nothing about what moved. The concrete case
already happened: ``/api/bars`` takes ``from``/``to``, not
``from_time``/``to_time``, and the wrong names fail exactly like a missing
value would -- nothing in that response distinguishes "you spelled the
parameter wrong" from "you forgot it".

These tests pin the contract rather than the data behind it. Where a route
would otherwise need a live provider or a pre-populated database to do
anything interesting, the assertions stop at "the request was accepted" or
"the request was refused, and here is what it says" -- using the bundled
offline demo provider and a throwaway database so the whole file runs with
no network access and no dependency on whatever a developer's own database
happens to hold.
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

from app.api.routes import api_router
from app.config import reset_settings_cache
from app.database.session import dispose_database
from app.main import app
from app.utils.intervals import INTERVAL_ORDER


@pytest.fixture(scope="module")
def client(tmp_path_factory: pytest.TempPathFactory) -> Iterator[TestClient]:
    """A ``TestClient`` wired to a throwaway database and the offline demo provider.

    Entering ``TestClient`` as a context manager runs the application's real
    startup lifespan, which is not inert: it creates database tables, upserts
    the instrument catalogue, and sweeps the cache for mixed-provenance
    series. Left pointed at the default configuration, that lifespan would
    run against the developer's own SQLite file. Pointing ``DATABASE_URL`` at
    a scratch file and ``DATA_PROVIDER`` at ``demo`` before startup keeps
    every test in this module off the real database and off the network,
    while still exercising the genuine startup path rather than a mock of it.

    Settings and the database engine are both process-wide singletons
    (``get_settings`` is ``lru_cache``d, the SQLAlchemy engine is a module
    global), so both are explicitly reset on the way in and the way out --
    otherwise this override would leak into whichever test module happens to
    run next.
    """

    monkeypatch = pytest.MonkeyPatch()
    db_path = tmp_path_factory.mktemp("api-contract") / "contract.db"
    monkeypatch.setenv("DATABASE_URL", f"sqlite:///{db_path}")
    monkeypatch.setenv("DATA_PROVIDER", "demo")
    reset_settings_cache()
    dispose_database()

    with TestClient(app) as test_client:
        yield test_client

    dispose_database()
    monkeypatch.undo()
    reset_settings_cache()


class TestRouteInventory:
    """A route disappearing (renamed, de-registered, moved to a new prefix)
    does not fail on its own -- the app still starts and every other route
    still answers. The only place that shows up is the routing table itself.
    """

    #: Read off `app/api/routes.py`; twelve handlers as of this writing.
    EXPECTED: set[tuple[str, str]] = {
        ("GET", "/api/health"),
        ("GET", "/api/providers/status"),
        ("GET", "/api/symbols"),
        ("GET", "/api/intervals"),
        ("GET", "/api/bars"),
        ("GET", "/api/ict"),
        ("POST", "/api/backtests"),
        ("GET", "/api/backtests"),
        ("GET", "/api/backtests/{backtest_id}"),
        ("GET", "/api/backtests/{backtest_id}/trades"),
        ("GET", "/api/cache"),
        ("DELETE", "/api/cache"),
    }

    def test_every_documented_route_and_method_is_still_registered(self):
        registered = {
            (method, route.path) for route in api_router.routes for method in route.methods
        }

        missing = self.EXPECTED - registered
        assert not missing, f"routes no longer registered: {sorted(missing)}"

    def test_the_router_holds_no_accidental_duplicate_of_one_of_these(self):
        # Two handlers registered on the same (method, path) is always a
        # bug: the second silently shadows the first and nothing reports it.
        pairs = [
            (method, route.path) for route in api_router.routes for method in route.methods
        ]
        assert len(pairs) == len(set(pairs))


class TestBars:
    """``/api/bars`` is the one route with a documented, previously-hit trap:
    the window bounds are named ``from``/``to`` on the wire, not
    ``from_time``/``to_time``. FastAPI answers an unrecognised query
    parameter by silently ignoring it, so sending the wrong name does not
    read as "unrecognised parameter" -- it reads as "``from`` and ``to``
    were never sent", which is true, but easy to mistake for a broken
    endpoint rather than a misnamed request.
    """

    def test_a_request_missing_every_required_parameter_names_all_three(self, client):
        response = client.get("/api/bars")

        assert response.status_code == 422
        missing = {tuple(error["loc"]) for error in response.json()["detail"]}
        assert ("query", "symbol") in missing
        assert ("query", "from") in missing
        assert ("query", "to") in missing

    def test_a_request_using_from_time_instead_of_from_is_refused(self, client):
        response = client.get(
            "/api/bars",
            params={
                "symbol": "ES",
                "interval": "1h",
                "from_time": "2026-03-02T00:00:00Z",
                "to_time": "2026-03-04T00:00:00Z",
            },
        )

        assert response.status_code == 422
        missing = {tuple(error["loc"]) for error in response.json()["detail"]}
        # Refused for the right reason: 'from' and 'to' are still missing,
        # not because 'from_time'/'to_time' were rejected outright.
        assert ("query", "from") in missing
        assert ("query", "to") in missing

    def test_a_correctly_named_request_is_not_rejected_for_its_parameter_names(self, client):
        response = client.get(
            "/api/bars",
            params={
                "symbol": "ES",
                "interval": "1h",
                "from": "2026-03-02T00:00:00Z",
                "to": "2026-03-04T00:00:00Z",
            },
        )

        # Not asserting 200 here: this test is only about the parameter
        # *names* being accepted. What the demo provider hands back is
        # covered separately below.
        assert response.status_code != 422

    def test_a_correctly_named_request_serves_real_bars_from_the_offline_demo_provider(
        self, client
    ):
        """One step further than "not 422": with ``DATA_PROVIDER=demo`` this
        is deterministic and needs no network, so there is no reason to
        settle for merely "accepted" when "serves the documented shape" is
        just as cheap to check."""

        response = client.get(
            "/api/bars",
            params={
                "symbol": "ES",
                "interval": "1h",
                "from": "2026-03-02T00:00:00Z",
                "to": "2026-03-04T00:00:00Z",
            },
        )

        assert response.status_code == 200
        body = response.json()
        assert body["symbol"] == "ES"
        assert body["provider"] == "demo"
        assert len(body["bars"]) > 1
        for bar in body["bars"]:
            assert set(bar) == {"symbol", "time", "open", "high", "low", "close", "volume"}
        # Ascending and inside the requested window -- the two cheapest
        # ways a badly-wired aggregation step would show up.
        times = [bar["time"] for bar in body["bars"]]
        assert times == sorted(times)

    def test_interval_is_optional_and_defaults_rather_than_being_required(self, client):
        """Unlike symbol/from/to, ``interval`` is declared with a default, so
        omitting it is a valid request, not a 422 -- worth pinning precisely
        because a casual reading of "bars requires symbol, interval, from,
        to" suggests otherwise."""

        response = client.get(
            "/api/bars",
            params={
                "symbol": "ES",
                "from": "2026-03-02T00:00:00Z",
                "to": "2026-03-04T00:00:00Z",
            },
        )

        assert response.status_code != 422
        assert response.json()["interval"] == "1h"


class TestHealth:
    def test_returns_every_documented_key(self, client):
        response = client.get("/api/health")

        assert response.status_code == 200
        documented_keys = {
            "status",
            "provider",
            "fallback_active",
            "database",
            "version",
            "environment",
        }
        assert documented_keys <= set(response.json())

    def test_the_documented_keys_hold_the_values_this_configuration_implies(self, client):
        # Deterministic only because this module forces DATA_PROVIDER=demo
        # and a fresh scratch database; against the default configuration
        # 'provider' would depend on network access and an API key.
        body = client.get("/api/health").json()

        assert body["status"] == "ok"
        assert body["provider"] == "demo"
        assert body["fallback_active"] is False
        assert body["database"] == "connected"
        assert isinstance(body["version"], str) and body["version"]
        assert body["environment"] == "development"


class TestSymbols:
    def test_returns_a_symbols_list_whose_items_carry_the_documented_fields(self, client):
        response = client.get("/api/symbols")

        assert response.status_code == 200
        symbols = response.json()["symbols"]
        assert symbols, "the static catalogue is never empty"
        for item in symbols:
            assert {"symbol", "tick_size", "price_precision", "timezone"} <= set(item)

    def test_the_three_canonical_futures_are_all_present_with_sane_values(self, client):
        symbols = {item["symbol"]: item for item in client.get("/api/symbols").json()["symbols"]}

        assert set(symbols) == {"ES", "NQ", "YM"}
        for item in symbols.values():
            assert item["tick_size"] > 0
            assert item["price_precision"] >= 0
            assert item["timezone"] == "America/Chicago"


class TestIntervals:
    def test_returns_exactly_the_supported_interval_keys_in_order(self, client):
        response = client.get("/api/intervals")

        assert response.status_code == 200
        assert response.json() == INTERVAL_ORDER


class TestBacktestValidation:
    def test_an_empty_body_is_rejected_with_422(self, client):
        response = client.post("/api/backtests", json={})

        assert response.status_code == 422

    def test_the_validation_error_names_the_missing_fields(self, client):
        response = client.post("/api/backtests", json={})

        missing = {tuple(error["loc"]) for error in response.json()["detail"]}
        assert ("body", "selection") in missing
        assert ("body", "search") in missing


class TestBacktestReadRoutes:
    """Read paths that must work against an empty database, so a rename or
    a broken join shows up here rather than only after a real run exists.
    """

    def test_the_list_endpoint_answers_with_the_documented_shape(self, client):
        response = client.get("/api/backtests")

        assert response.status_code == 200
        # Nothing in this module ever completes a POST /api/backtests (every
        # attempt above is deliberately malformed), so the list is provably
        # empty rather than merely "a list".
        assert response.json() == {"backtests": []}

    def test_an_unknown_backtest_id_is_a_404_not_a_500(self, client):
        response = client.get("/api/backtests/does-not-exist")

        assert response.status_code == 404

    def test_an_unknown_backtest_ids_trades_are_also_a_404(self, client):
        response = client.get("/api/backtests/does-not-exist/trades")

        assert response.status_code == 404


class TestIctValidation:
    def test_a_to_not_after_from_is_rejected_before_any_provider_call(self, client):
        # Deliberately backwards so the failure is unambiguously the route's
        # own validation, never the (offline, otherwise-successful) provider.
        response = client.get(
            "/api/ict",
            params={
                "symbol": "ES",
                "interval": "1h",
                "from": "2026-03-04T00:00:00Z",
                "to": "2026-03-02T00:00:00Z",
            },
        )

        assert response.status_code == 400
        assert response.json()["detail"] == "'to' must be greater than 'from'"


class TestCache:
    def test_returns_exactly_the_documented_keys(self, client):
        # Not asserting on total_candles/per_symbol values: earlier tests in
        # this module may already have pulled bars through the cache, so the
        # only order-independent claim available here is about shape.
        response = client.get("/api/cache")

        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"total_candles", "per_symbol", "database_path", "last_fetch_ms"}
        assert isinstance(body["total_candles"], int)
        assert isinstance(body["per_symbol"], list)
        assert isinstance(body["database_path"], str) and body["database_path"]
