import logging
from logging.handlers import RotatingFileHandler

from app.config import get_settings


def configure_logging():
    folder = get_settings().data_dir
    for name in ("uploads", "backups", "logs"):
        (folder / name).mkdir(parents=True, exist_ok=True)
    logger = logging.getLogger("study_surfers")
    for handler in list(logger.handlers):
        handler.close()
        logger.removeHandler(handler)
    handler = RotatingFileHandler(
        folder / "logs/backend.log", maxBytes=2_000_000, backupCount=3, encoding="utf-8"
    )
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)


def close_logging():
    logger = logging.getLogger("study_surfers")
    for handler in list(logger.handlers):
        handler.close()
        logger.removeHandler(handler)
