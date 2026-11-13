"""Suite-wide isolation from the machine the tests run on."""

import logging
import os
from logging.handlers import RotatingFileHandler

import pytest

# The Massive budget survives restarts through a state file under backend/var.
# A developer's own session leaves calls in it, and a test that builds a
# MassiveProvider would then be paced -- or refused -- by requests made from
# the browser an hour earlier. Off for the suite; the tests that need the
# file pass their own path. Set before anything reads the settings.
os.environ["MASSIVE_QUOTA_STATE_FILE"] = ""

from app.config import reset_settings_cache  # noqa: E402


@pytest.fixture(scope='session', autouse=True)
def isolated_test_log(tmp_path_factory):
    """Keep deliberate test failures out of the running application's diagnostics."""
    path = tmp_path_factory.mktemp('backend-diagnostics') / 'tests.log'
    with pytest.MonkeyPatch.context() as patch:
        patch.setenv('LOG_FILE', str(path))
        reset_settings_cache()
        try:
            yield path
        finally:
            root = logging.getLogger()
            for handler in root.handlers[:]:
                if isinstance(handler, RotatingFileHandler) and handler.baseFilename == str(path):
                    root.removeHandler(handler)
                    handler.close()
    reset_settings_cache()
