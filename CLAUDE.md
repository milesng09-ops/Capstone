# Market Replay Lab

## Running the backend

Use the project virtualenv at `backend/.venv`, **not** the global `python` on
PATH. The global interpreter has none of the dependencies installed, and the
way it fails is misleading: `pytest` collects most of the suite fine and only
`test_cache_provenance.py` and `test_ict_service.py` blow up with
`ModuleNotFoundError: No module named 'sqlalchemy'`. That reads like two
broken test files rather than the wrong interpreter, and a run that reports
"84 passed" alongside those errors looks close enough to green to wave
through. The real suite is 327 tests.

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
is 239 tests across 15 files.
