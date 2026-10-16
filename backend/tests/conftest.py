import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.db import get_engine
from app.main import app


@pytest.fixture
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("SS_DATA_DIR", str(tmp_path))
    monkeypatch.setenv("SS_SEED_DEMO", "0")
    get_settings.cache_clear()
    get_engine.cache_clear()
    with TestClient(app, base_url="http://127.0.0.1:8765") as client:
        yield client
    get_engine().dispose()
    get_engine.cache_clear()
    get_settings.cache_clear()
