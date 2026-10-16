import json

from app.config import ROOT
from app.db import SCHEMA_VERSION, get_engine
from app.main import app


def test_health(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"


def test_init_creates_schema_and_sets_user_version(client):
    with get_engine().connect() as conn:
        assert conn.exec_driver_sql("PRAGMA user_version").scalar_one() == SCHEMA_VERSION
        assert conn.exec_driver_sql("PRAGMA journal_mode").scalar_one() == "wal"


def test_error_shape(client):
    assert client.get("/api/missing").json() == {
        "detail": "Путь API не найден",
        "code": "not_found",
        "context": {},
    }


def test_contract_up_to_date():
    assert app.openapi() == json.loads((ROOT / "contract/openapi.json").read_text("utf-8"))
