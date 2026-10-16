import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.ai.credentials import decrypt_secret
from app.ai.errors import AiGatewayError
from app.ai.models import AiProviderConnection
from app.ai.schemas import AiSettingsRead
from app.ai.settings import validate_base_url
from app.db import session_factory


@pytest.fixture
def ai_client(client):
    from app.ai.router import router
    from app.main import app

    isolated = FastAPI(exception_handlers=app.exception_handlers)
    isolated.include_router(router)
    with TestClient(isolated) as transport:
        yield transport


@pytest.mark.parametrize(
    "url",
    [
        "http://localhost:1234/v1",
        "http://127.0.0.2:1234/v1",
        "http://[::1]:1234/v1",
        "http://host.docker.internal:1234/v1",
        "https://api.openai.com/v1",
    ],
)
def test_allowed_base_urls(url):
    assert validate_base_url(" " + url + "/ ") == url


@pytest.mark.parametrize(
    "url,code",
    [
        ("ftp://example.com/v1", "ai_base_url_invalid"),
        ("http://192.168.1.12/v1", "ai_base_url_https_required"),
        ("http://localhost.example.com/v1", "ai_base_url_https_required"),
        ("https://user:secret@example.com/v1", "ai_base_url_credentials_forbidden"),
        ("https://example.com/v1?api_key=secret", "ai_base_url_invalid"),
        ("https://example.com:bad/v1", "ai_base_url_invalid"),
    ],
)
def test_bad_base_urls(url, code):
    with pytest.raises(AiGatewayError) as raised:
        validate_base_url(url)
    assert raised.value.code == code


def test_http_never_returns_secret_and_empty_put_keeps_key(ai_client):
    client = ai_client
    body = {"label": "Облако", "base_url": "https://example.com/v1", "api_key": "SUPER-SECRET-123"}
    response = client.post("/api/settings/ai/providers", json=body)
    assert response.status_code == 201
    assert "SUPER-SECRET" not in response.text
    provider_id = response.json()["providers"][0]["id"]
    assert response.json()["providers"][0]["updated_at"].endswith("Z")
    response = client.put(f"/api/settings/ai/providers/{provider_id}", json=body | {"api_key": ""})
    assert response.status_code == 200 and response.json()["providers"][0]["has_api_key"] is True
    with session_factory()() as session:
        ciphertext = session.get(AiProviderConnection, provider_id).api_key_ciphertext
        assert b"SUPER-SECRET" not in ciphertext and decrypt_secret(ciphertext) == body["api_key"]
    response = client.get("/api/settings/ai")
    assert set(response.json()) == set(AiSettingsRead.model_fields)
    assert set(response.json()) == {
        "external_models_enabled",
        "daily_limit_usd",
        "operation_limit_usd",
        "confirm_cost_usd",
        "confirm_input_tokens",
        "usd_rub_rate",
        "usd_rub_rate_date",
        "default_text",
        "default_speech",
        "chat_preset",
        "providers",
        "roles",
        "models",
        "today_usage",
    }
    assert [r["role"] for r in response.json()["roles"]] == ["extract", "generate"]
    assert response.json()["default_speech"] is None and response.json()["chat_preset"] is None
    assert "SUPER-SECRET" not in response.text


def test_local_provider_without_key_and_model_favorites(ai_client):
    client = ai_client
    response = client.post(
        "/api/settings/ai/providers",
        json={"label": "LM Studio", "base_url": "http://localhost:1234/v1"},
    )
    provider_id = response.json()["providers"][0]["id"]
    response = client.put(
        f"/api/settings/ai/providers/{provider_id}/models/manual",
        json={"model_id": "qwen/test", "display_name": "Qwen"},
    )
    assert response.status_code == 200
    selection = {"provider_id": provider_id, "model_id": "qwen/test"}
    assert (
        client.put("/api/settings/ai/defaults/text", json={"selection": selection}).status_code
        == 200
    )
    assert (
        client.put("/api/settings/ai/model-favorites", json={"models": [selection]}).json()[
            "models"
        ][0]["favorite_order"]
        == 0
    )
    response = client.delete(
        f"/api/settings/ai/providers/{provider_id}/models", params={"model_id": "qwen/test"}
    )
    assert response.status_code == 409 and response.json()["code"] == "ai_model_in_use"
    from app.ai.settings import credential

    with session_factory()() as session:
        assert credential(session, provider_id) == "not-needed"
    presets = client.get("/api/settings/ai/presets").json()
    assert (
        len(presets) == 5
        and next(p for p in presets if p["key"] == "lmstudio")["requires_key"] is False
    )


def test_duplicate_provider_label_is_conflict(ai_client):
    client = ai_client
    body = {"label": "Test", "base_url": "http://localhost:1234/v1"}
    assert client.post("/api/settings/ai/providers", json=body).status_code == 201
    response = client.post("/api/settings/ai/providers", json=body | {"label": "test"})
    assert response.status_code == 409 and response.json()["code"] == "ai_provider_label_exists"
