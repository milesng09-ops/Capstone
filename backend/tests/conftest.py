"""Keep deliberate test failures out of the running application's diagnostics."""
import logging
from logging.handlers import RotatingFileHandler

import pytest

from app.config import reset_settings_cache


@pytest.fixture(scope='session', autouse=True)
def isolated_test_log(tmp_path_factory):
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
