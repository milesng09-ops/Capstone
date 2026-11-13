import logging
from logging.handlers import RotatingFileHandler

from fastapi.testclient import TestClient
from fastapi import HTTPException
from app.main import create_app
from app.utils.error_logging import SafeFormatter, configure_error_log


def test_server_error_is_visible_and_has_a_matching_private_trace(tmp_path):
    path = tmp_path/'backend.log'
    root = logging.getLogger()
    previous = [(h, h.formatter) for h in root.handlers]
    configure_error_log(str(path))
    configure_error_log(str(path))  # Repeated startup must not duplicate files.
    app = create_app()
    @app.get('/test-error')
    async def fail():
        raise RuntimeError('provider failed apiKey=private-key Bearer private-token')
    @app.get('/test-rejection')
    async def reject():
        raise HTTPException(422, 'Insufficient history apiKey=private-key')
    try:
        # No lifespan: this middleware-only test must not initialize or modify
        # the developer's market database.
        client = TestClient(app, raise_server_exceptions=False)
        try:
            response = client.get('/test-error?apiKey=another-private-key')
            rejected = client.get('/unknown-route')
            invalid = client.get('/test-rejection')
        finally:
            client.close()
        assert response.status_code == 500
        reference = response.headers['X-Request-ID']
        assert reference and reference != rejected.headers['X-Request-ID']
        assert 'private-key' not in response.text
        saved = path.read_text()
        assert reference in saved and 'RuntimeError' in saved
        assert 'private-key' not in saved and 'private-token' not in saved
        assert 'another-private-key' not in saved
        assert rejected.headers['X-Request-ID'] in saved
        assert invalid.headers['X-Request-ID'] in saved
        assert 'Insufficient history' in saved
        assert 'private-key' not in invalid.text
        assert len([h for h in root.handlers if isinstance(h, RotatingFileHandler)
                    and h.baseFilename == str(path)]) == 1
    finally:
        for handler in root.handlers[:]:
            if isinstance(handler, RotatingFileHandler) and handler.baseFilename == str(path):
                root.removeHandler(handler)
                handler.close()
        for handler, formatter in previous:
            handler.setFormatter(formatter)


def test_formatter_redacts_credentials_in_tracebacks():
    formatter = SafeFormatter('%(message)s')
    try:
        raise ValueError('MASSIVE_API_KEY=secret-value password="hidden"')
    except ValueError:
        import sys
        record = logging.LogRecord('test', logging.ERROR, '', 1, 'failed', (), sys.exc_info())
        value = formatter.format(record)
    assert 'secret-value' not in value and 'hidden' not in value
    assert 'ValueError' in value
