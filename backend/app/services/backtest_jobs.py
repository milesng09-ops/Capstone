"""Backtests as background jobs the page polls, instead of one long request.

Why: a GXT run over months of 1-minute candles spends ten minutes or more
waiting on Massive's five-a-minute quota. Held open as a single request the
page could show nothing but "Testing...", and a refresh lost the run -- while
the server kept working on it under the same session, so the next attempt was
refused as "already running" with nothing on screen to explain why.

A job runs the same :meth:`BacktestService.run`, so the one-run-per-session
rule, validation and storage are unchanged. It records where it is (see
:mod:`app.services.progress`) and how it ended, and a refreshed page finds it
again through ``current``.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Literal

from app.models.schemas import BacktestRequest
from app.services import progress as progress_module
from app.services.progress import Progress

logger = logging.getLogger(__name__)

JobStatus = Literal["running", "succeeded", "failed"]

#: Finished jobs are kept this long so a page that was away can still read the
#: outcome, then dropped: the run itself is stored, the job is only a receipt.
FINISHED_RETENTION_SECONDS = 60 * 60
MAX_JOBS = 200


@dataclass
class BacktestJob:
    id: str
    session_id: str
    strategy: str
    started_at: float = field(default_factory=time.time)
    finished_at: float | None = None
    status: JobStatus = "running"
    progress: Progress = field(default_factory=Progress)
    backtest_id: str | None = None
    error: str | None = None
    error_status: int | None = None
    task: asyncio.Task | None = field(default=None, repr=False)


class BacktestJobs:
    def __init__(self) -> None:
        self._jobs: dict[str, BacktestJob] = {}

    def start(self, request: BacktestRequest, session_id: str, service, translate) -> BacktestJob:
        """Start ``service.run`` in the background and return its job at once.

        ``translate`` turns an exception into ``(http_status, user_message)``;
        it is the same mapping the synchronous endpoint uses, so a job's error
        reads exactly as the old response did.
        """

        self._prune()
        job = BacktestJob(id=uuid.uuid4().hex, session_id=session_id, strategy=request.strategy)
        self._jobs[job.id] = job

        async def runner() -> None:
            progress_module.bind(job.progress)
            try:
                result = await service.run(request, session_id)
                job.backtest_id = result.id
                job.status = "succeeded"
                job.progress.stage = "Finished"
                job.progress.detail = None
            except Exception as exc:  # noqa: BLE001 - every failure must reach the page
                status_code, message = translate(exc)
                if status_code >= 500:
                    logger.exception("Backtest job %s failed", job.id)
                else:
                    logger.warning("Backtest job %s refused (%s): %s", job.id, status_code, message)
                job.status = "failed"
                job.error = message
                job.error_status = status_code
            finally:
                job.finished_at = time.time()
                job.progress.waiting_until = None

        job.task = asyncio.create_task(runner(), name=f"backtest-job-{job.id}")
        return job

    def get(self, job_id: str, session_id: str) -> BacktestJob | None:
        job = self._jobs.get(job_id)
        # Another tab's job is not this one's business; treat it as unknown.
        return job if job is not None and job.session_id == session_id else None

    def current(self, session_id: str) -> BacktestJob | None:
        """The session's running job, else its most recent finished one."""

        mine = [job for job in self._jobs.values() if job.session_id == session_id]
        running = [job for job in mine if job.status == "running"]
        pool = running or mine
        return max(pool, key=lambda job: job.started_at) if pool else None

    def _prune(self) -> None:
        now = time.time()
        for job_id, job in list(self._jobs.items()):
            if job.finished_at is not None and now - job.finished_at > FINISHED_RETENTION_SECONDS:
                del self._jobs[job_id]
        if len(self._jobs) > MAX_JOBS:
            finished = sorted(
                (job for job in self._jobs.values() if job.finished_at is not None),
                key=lambda job: job.finished_at or 0,
            )
            for job in finished[: len(self._jobs) - MAX_JOBS]:
                del self._jobs[job.id]


_jobs: BacktestJobs | None = None


def get_backtest_jobs() -> BacktestJobs:
    global _jobs
    if _jobs is None:
        _jobs = BacktestJobs()
    return _jobs
