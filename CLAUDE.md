# Market Replay Lab

## Running the backend

Use the project virtualenv at `backend/.venv`, **not** the global `python` on
PATH. The global interpreter has none of the dependencies installed, and the
way it fails is misleading: `pytest` collects most of the suite fine and only
`test_cache_provenance.py` and `test_ict_service.py` blow up with
`ModuleNotFoundError: No module named 'sqlalchemy'`. That reads like two
broken test files rather than the wrong interpreter, and a run that reports
"84 passed" alongside those errors looks close enough to green to wave
through. The real suite is 545 tests.

```bash
cd backend && .venv/Scripts/python.exe -m pytest tests -q
```

`.venv/Scripts/` is the Windows layout; it is `.venv/bin/` elsewhere.
Dependencies come from `backend/requirements.txt`, and the project needs
Python 3.10+ (currently 3.12.4) — the floor is PEP 604 `str | None` syntax,
which Pydantic and SQLAlchemy evaluate when models are built.

## Running the frontend

```bash
cd frontend && npm run test
```

`npm run typecheck` runs `tsc --noEmit`; `npm run dev` starts Vite. The suite
is 454 tests across 23 files.

## Running the browser tests

```bash
cd frontend && npm run test:e2e
```

Twenty Playwright tests in `frontend/e2e/`, separate from the vitest suite
because they answer a question vitest structurally cannot. **jsdom computes no
layout**: every element has a zero-sized box, so nothing there can tell
whether a surface covers its pane or a menu fits on the screen — and both of
the bugs that have reached the user were exactly that.

- Every drawing tool was dead because the overlay canvas was 300x150 in the
  corner of the pane rather than covering it. Forty-six gesture tests passed
  throughout, because they render the overlay alone and never ask its size.
- The chart settings menu was clamped against a written-down 168px while it
  had grown to 251, inside an ancestor that hides overflow, so the switches
  that unlink the charts had nowhere to be.

So the assertions there are about size, position and containment. They need
no backend and no provider key — the API is stubbed in `e2e/fixtures.ts`, and
the bars are a fixed-seed walk so the chart is the same on every run.
Playwright starts its own Vite on port 5199; the first run needs
`npx playwright install chromium`.

Both suites and the typecheck also run in GitHub Actions on every push to
`master` — see `.github/workflows/ci.yml`.
