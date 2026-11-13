"""Backtests run as background jobs: progress while running, the outcome after.

The reason they exist is a GXT run that spent ten minutes on Massive's quota
inside one request: the page could only say "Testing...", and a refresh lost
the run while the server kept it -- so the next attempt was refused as already
running, with nothing on screen to say why. These pin the parts that fixed
that: the job answers at once, says what it is doing, survives a refresh via
``current``, and ends with either a stored run or the error message.
"""

from __future__ import annotations

import asyncio
import time

import pytest

from app.api.deps import backtest_jobs, backtest_service
from app.main import app
from app.providers.base import ProviderRateLimitError
from app.services import progress
from app.services.backtest_jobs import BacktestJobs
from app.services.backtest_service import BacktestValidationError

from test_api_contract import client  # noqa: F401 - the shared fixture

BODY = {
    "primary_symbol": "NQ", "symbols": ["NQ"], "interval": "1h",
    "selection": {"start_time": 0, "end_time": 4 * 3_600_000},
    "search": {"lookback_start": 0, "lookback_end": 100 * 3_600_000},
}


class Result:
    id = "stored-run"


class SlowService:
    """Reports a stage, then waits for the test to let it finish."""

    def __init__(self, outcome=None):
        self.release = asyncio.Event()
        self.outcome = outcome

    async def run(self, request, session_id):
        progress.report("Loading NQ 1m candles", done=3, total=14)
        progress.waiting("Massive", 42, 5)
        await self.release.wait()
        if isinstance(self.outcome, Exception):
            raise self.outcome
        return Result()


@pytest.fixture
def wired(client):  # noqa: F811
    def wire(service):
        jobs = BacktestJobs()
        app.dependency_overrides[backtest_service] = lambda: service
        app.dependency_overrides[backtest_jobs] = lambda: jobs
        return jobs
    yield wire
    app.dependency_overrides.pop(backtest_service, None)
    app.dependency_overrides.pop(backtest_jobs, None)


def _wait_until_finished(client, job_id, headers, timeout=5.0):  # noqa: F811
    deadline = time.time() + timeout
    while time.time() < deadline:
        job = client.get(f"/api/backtests/jobs/{job_id}", headers=headers).json()
        if job["status"] != "running":
            return job
        time.sleep(0.02)
    raise AssertionError("job never finished")


def _release(client, service):  # noqa: F811
    # The event belongs to the app's loop; set it from there.
    client.portal.call(service.release.set)


def test_a_job_answers_at_once_and_says_what_it_is_waiting_on(client, wired):  # noqa: F811
    service = SlowService()
    wired(service)
    headers = {"X-Session-Id": "tab-a"}

    started = client.post("/api/backtests/jobs", json=BODY, headers=headers)
    assert started.status_code == 202, started.text
    job_id = started.json()["id"]

    running = client.get(f"/api/backtests/jobs/{job_id}", headers=headers).json()
    assert running["status"] == "running"
    assert running["stage"] == "Loading NQ 1m candles"
    assert (running["done"], running["total"]) == (3, 14)
    assert "Massive's rate limit" in running["detail"]
    assert running["waiting_until"] > time.time()

    _release(client, service)
    finished = _wait_until_finished(client, job_id, headers)
    assert finished["status"] == "succeeded"
    assert finished["backtest_id"] == "stored-run"
    assert finished["waiting_until"] is None


def test_a_refreshed_page_finds_its_running_job(client, wired):  # noqa: F811
    service = SlowService()
    wired(service)
    headers = {"X-Session-Id": "tab-b"}
    job_id = client.post("/api/backtests/jobs", json=BODY, headers=headers).json()["id"]

    # The same tab (sessionStorage keeps the id across a refresh) asks again.
    again = client.post("/api/backtests/jobs", json=BODY, headers=headers)
    assert again.status_code == 409
    current = client.get("/api/backtests/jobs/current", headers=headers).json()
    assert current["id"] == job_id

    # Another tab neither sees it nor is blocked by it.
    other = client.get(f"/api/backtests/jobs/{job_id}", headers={"X-Session-Id": "tab-c"})
    assert other.status_code == 404
    _release(client, service)
    _wait_until_finished(client, job_id, headers)


@pytest.mark.parametrize(
    "error, status, text",
    [
        (BacktestValidationError("Insufficient GXT history."), 422, "Insufficient GXT history."),
        (ProviderRateLimitError("Massive rate limit exceeded", provider="massive"), 429, "quota ran out"),
        (RuntimeError("boom"), 500, "Check the server log"),
    ],
)
def test_a_failed_job_carries_the_message_the_old_response_had(client, wired, error, status, text):  # noqa: F811
    service = SlowService(outcome=error)
    wired(service)
    headers = {"X-Session-Id": f"tab-fail-{status}"}
    job_id = client.post("/api/backtests/jobs", json=BODY, headers=headers).json()["id"]
    _release(client, service)
    finished = _wait_until_finished(client, job_id, headers)
    assert finished["status"] == "failed"
    assert finished["error_status"] == status
    assert text in finished["error"]
    assert "boom" not in finished["error"]


def test_no_job_yet_is_a_404_not_an_error(client, wired):  # noqa: F811
    wired(SlowService())
    response = client.get("/api/backtests/jobs/current", headers={"X-Session-Id": "fresh-tab"})
    assert response.status_code == 404


def test_reports_outside_a_job_go_nowhere():
    # The chart's own bar requests run the same data code with no job bound.
    progress.report("Loading", done=1, total=2)
    progress.waiting("Massive", 10, 5)
