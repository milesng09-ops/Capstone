# Market Replay Lab

Mark a setup on a chart, test it against history, and read the win rate —
instead of spending months stepping through bar replay by hand.

Educational and research use only. Historical results do not guarantee future
performance.

---

## Running it

Two processes: a FastAPI backend on port 8000 and a Vite frontend on 5173.

**Requirements: Python 3.10 or newer** (3.12 recommended) and Node 18+.

> The `python3` that ships with macOS is usually 3.9, which is too old — the
> models use `str | None` annotations that Pydantic and SQLAlchemy evaluate at
> import time. Check with `python3 --version`; if it is below 3.10, install a
> newer one (`brew install python@3.12`) and use `python3.12` explicitly when
> creating the virtual environment. Building the venv with the wrong
> interpreter is the one mistake that is awkward to undo — everything installs
> cleanly and then fails at startup.

### Backend

<details open>
<summary><b>macOS / Linux</b></summary>

```bash
cd backend && python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
```

```bash
cd backend && .venv/bin/python -m uvicorn app.main:app --reload --port 8000
```
</details>

<details>
<summary><b>Windows</b></summary>

```powershell
cd backend; python -m venv .venv; .venv\Scripts\pip install -r requirements.txt
```

```powershell
cd backend; .venv\Scripts\python -m uvicorn app.main:app --reload --port 8000
```
</details>

The difference is only the layout of the virtual environment: POSIX puts
executables in `.venv/bin`, Windows in `.venv\Scripts`. Everything after that
is identical. Calling the interpreter through its full path means you never
have to remember whether the environment is activated.

### Frontend

Same on every platform, in a second terminal:

```bash
cd frontend && npm install && npm run dev
```

Then open http://localhost:5173. Interactive API docs are at
http://localhost:8000/docs.

No API key is needed to start. The backend falls back automatically:
Massive → Yahoo Finance → bundled demo data. Demo data is synthetic and
generated from a fixed seed; the UI labels it as such everywhere it appears, so
a win rate computed on it can never be mistaken for one computed on real prices.
To use live data, put `MASSIVE_API_KEY=...` in `backend/.env`.

### Tests

```bash
cd backend && .venv/bin/python -m pytest tests/ -q      # .venv\Scripts\ on Windows
```

```bash
cd frontend && npm test
```

### Housekeeping

Saved backtest runs store their metrics as computed at the time and are never
recalculated on read, so a change to the metrics leaves old runs inconsistent
with new ones. To clear them (the candle cache is left alone):

```bash
cd backend && .venv/bin/python -m scripts.clear_backtests        # dry run
```

Add `--yes` to delete, or `--before YYYY-MM-DD` to keep recent runs.

---

## How it fits together

```
Market data provider  ->  backend cache  ->  ICT detectors  ->  chart overlays
   (Massive/Yahoo)         (SQLite)         swings, FVG, SMT        (canvas)
                                 |
                                 +-------->  pattern search  ->  backtest engine
                                             (deterministic)      win rate, equity,
                                                                  trade list
```

- `backend/app/providers/` — vendor adapters behind one interface, with a
  health registry and automatic fallback.
- `backend/app/services/candle_service.py` — cache lookup, gap-only fetching,
  aggregation. Every bar in the app comes through here.
- `backend/app/analysis/` — the ICT detectors. Pure, deterministic, no training.
- `backend/app/backtesting/` — event-based simulation, one bar at a time.
- `frontend/src/components/chart/` — Lightweight Charts plus our own overlay.

### The detectors

| Detector | Rule |
|---|---|
| **Swing point** | A candle whose high is not exceeded by the `strength` candles either side. Reports `confirmed_time` — the bar at which it became knowable — so nothing trades on a pivot that had not formed yet. |
| **Fair value gap** | Three candles where the first and third do not overlap. Tracks first touch, full fill, and how deep price traded back in. |
| **SMT divergence** | Two correlated markets at the same two bar times, where exactly one took the level. Bearish at a high, bullish at a low. |

An SMT divergence is only reported as valid when both anchors are meaningful on
the *reference* chart too — either both are swing points (`swing_pair`), or an
anchor sits exactly on the high or low of a fair value gap (`fvg_edge`).
Anything else is `unconfirmed` and hidden by default.

---

## Two decisions worth knowing

**Lightweight Charts, not Advanced Charts.** TradingView's Advanced Charts
licence covers companies shipping public web projects and explicitly excludes
personal use, hobby study and prototyping — which is what this is. Lightweight
Charts is Apache-2.0 and can be used freely. The cost is that it ships no
drawing tools, so `ChartOverlay.tsx` implements them: a trend line between two
points, a horizontal level, and a zone.

Drawings are stored in **market coordinates** (time and price), never pixels.
That is what lets a level stay on the same candle through zooming, panning and
an interval change, and it is why drawings survive a page reload.

**Correlated charts are stacked and locked together.** SMT divergence is read by
looking straight down a vertical line — the same candle on NQ and on ES, one
above the other. `chartSync.ts` keeps the crosshair and scroll position
identical across panels so that line means the same moment on every chart.

---

## Not built yet

- **Machine learning.** Deliberately deferred. The plan is to wire the pipeline
  end to end first, then let a model consume the detector output as features —
  XGBoost, MiniRocket and TS2Vec are the candidates. The detectors are rule-based
  and stay that way; a model would sit above them in the strategy builder.
- **Forward testing.** Live alerts when a setup appears in real time. Needs a
  live data feed, which backtesting does not.
