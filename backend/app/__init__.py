"""Market Replay Lab backend application package."""

import sys

__version__ = "0.1.0"

#: Models across this package annotate optional fields as ``str | None``
#: (PEP 604). Pydantic and SQLAlchemy evaluate those annotations when a model
#: class is built, so on an older interpreter the package fails at import with
#: ``TypeError: unsupported operand type(s) for |`` pointing at whichever model
#: happened to be imported first. That error says nothing about the real cause,
#: so the check is done here instead -- at the earliest shared import.
MINIMUM_PYTHON = (3, 10)

if sys.version_info < MINIMUM_PYTHON:
    raise RuntimeError(
        f"Market Replay Lab needs Python {'.'.join(map(str, MINIMUM_PYTHON))} or newer, "
        f"but this interpreter is {sys.version.split()[0]} at {sys.executable}.\n"
        "\n"
        "On macOS the system 'python3' is usually too old. Install a newer one and\n"
        "rebuild the virtual environment with it:\n"
        "\n"
        "    brew install python@3.12\n"
        "    rm -rf .venv && python3.12 -m venv .venv\n"
        "    .venv/bin/pip install -r requirements.txt\n"
    )

del sys
