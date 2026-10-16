import pytest

REMOTE = {"host": "example-host.ngrok-free.dev"}


@pytest.fixture(autouse=True)
def public_host(monkeypatch):
    monkeypatch.setenv("SS_PUBLIC_HOST", REMOTE["host"])


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("put", "/api/settings/ai"),
        ("post", "/api/settings/ai/providers"),
        ("put", "/api/settings/ai/providers/abc"),
        ("delete", "/api/settings/ai/providers/abc"),
        ("delete", "/api/settings/ai/providers/abc/credential"),
        ("post", "/api/settings/ai/subscriptions/codex/login"),
        ("post", "/api/settings/ai/mcp/install/claude"),
        ("get", "/api/tentex/status"),
        ("get", "/api/mcp/jobs"),
    ],
)
def test_remote_cannot_touch_local_settings(client, method, path):
    response = client.request(method, path, headers=REMOTE, json={})
    assert response.status_code == 403
    assert response.json()["code"] == "local_only"


def test_remote_can_play_and_read_settings(client):
    assert client.get("/api/health", headers=REMOTE).status_code == 200
    assert client.get("/api/decks", headers=REMOTE).status_code == 200
    assert client.get("/api/settings/ai", headers=REMOTE).status_code == 200


def test_local_host_is_not_restricted(client):
    response = client.get("/api/tentex/status", headers={"host": "127.0.0.1:8765"})
    assert response.status_code != 403
