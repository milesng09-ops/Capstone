"""Local rotating diagnostics with credential redaction, including tracebacks."""
import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path
import re


def redact(value: str) -> str:
    value = re.sub(r'(bearer\s+)[^\s"\'<>]+', r'\1[redacted]', value, flags=re.I)
    return re.sub(r'((?:api[_-]?key|\w*token|password|secret|authorization)["\']?\s*[:=]\s*["\']?)[^\s&"\'<>]+',
                  r'\1[redacted]', value, flags=re.I)


class SafeFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        return redact(super().format(record))


def configure_error_log(path: str) -> None:
    root = logging.getLogger()
    formatter = SafeFormatter('%(asctime)s %(levelname)-7s %(name)s | %(message)s')
    # Sanitize existing console handlers too, including formatted tracebacks.
    for handler in root.handlers:
        handler.setFormatter(formatter)
    target = Path(path).resolve()
    if any(isinstance(handler, RotatingFileHandler) and handler.baseFilename == str(target)
           for handler in root.handlers):
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    handler = RotatingFileHandler(target, maxBytes=5_000_000, backupCount=3, encoding='utf-8')
    handler.setLevel(logging.WARNING)
    handler.setFormatter(formatter)
    root.addHandler(handler)
