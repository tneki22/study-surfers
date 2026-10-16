import pytest

from app.config import get_settings
from app.request_security import RequestSecurityMiddleware


@pytest.mark.parametrize(
    "headers",
    [
        {"origin": "https://evil.example"},
        {"origin": "null"},
        {"origin": "https://evil.example", "sec-fetch-site": "same-origin"},
        {"sec-fetch-site": "cross-site"},
    ],
)
def test_foreign_form_rejected_before_handler(client, headers):
    response = client.post("/api/imports/quick", data={"text": "1. Вопрос?"}, headers=headers)
    assert response.status_code == 403
    assert response.json()["code"] == "request_origin_forbidden"
    assert client.get("/api/decks").json() == []


def test_hosts_and_origins_allow_local_dev_and_explicit_public(client):
    assert client.get("/api/health", headers={"host": "evil.example"}).status_code == 403
    get_settings().public_host = "study.example"
    assert (
        client.get(
            "/api/health", headers={"host": "study.example", "origin": "https://study.example"}
        ).status_code
        == 200
    )
    assert client.get("/api/decks", headers={"host": "study.example.evil.test"}).status_code == 403
    assert (
        client.get("/api/tentex/status", headers={"host": "study.example"}).json()["code"]
        == "local_only"
    )
    for origin in ("http://127.0.0.1:5180", "http://localhost:5180", "http://127.0.0.1:8765"):
        assert client.get("/api/health", headers={"origin": origin}).status_code == 200
    assert client.get("/api/health", headers={"origin": "http://127.0.0.1:8766"}).status_code == 403


def test_content_length_rejected_before_read(client):
    response = client.post(
        "/api/decks/import", content=b"", headers={"content-length": str(33 * 1024 * 1024)}
    )
    assert response.status_code == 413
    assert response.json()["code"] == "import_too_large"


def test_upload_redirect_alias_uses_same_budget():
    from app.request_security import body_limit

    for path in ("/api/imports/quick", "/api/imports/flashcards", "/api/decks/import"):
        assert body_limit(path + "/") == body_limit(path)


@pytest.mark.asyncio
async def test_stream_overflow_returns_413_and_closes_multipart_files(client, monkeypatch):
    import json

    from starlette import formparsers

    from app import request_security
    from app.main import app

    opened = []
    original = formparsers.SpooledTemporaryFile

    def tracked_file(*args, **kwargs):
        result = original(*args, **kwargs)
        opened.append(result)
        return result

    monkeypatch.setattr(formparsers, "SpooledTemporaryFile", tracked_file)
    first = (
        b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="deck.json"'
        b"\r\nContent-Type: application/json\r\n\r\n123"
    )
    monkeypatch.setattr(request_security, "body_limit", lambda path: len(first) + 5)
    chunks = iter(
        [
            {"type": "http.request", "body": first, "more_body": True},
            {"type": "http.request", "body": b"x" * 20, "more_body": False},
        ]
    )
    messages = []

    async def receive():
        return next(chunks, {"type": "http.disconnect"})

    async def send(message):
        messages.append(message)

    await app(
        {
            "type": "http",
            "asgi": {"version": "3.0", "spec_version": "2.4"},
            "http_version": "1.1",
            "method": "POST",
            "scheme": "http",
            "path": "/api/decks/import",
            "raw_path": b"/api/decks/import",
            "query_string": b"",
            "root_path": "",
            "server": ("127.0.0.1", 8765),
            "client": ("127.0.0.1", 12345),
            "headers": [
                (b"host", b"127.0.0.1:8765"),
                (b"content-type", b"multipart/form-data; boundary=boundary"),
            ],
        },
        receive,
        send,
    )
    assert messages[0]["status"] == 413
    body = b"".join(message.get("body", b"") for message in messages)
    assert json.loads(body)["code"] == "import_too_large"
    assert opened and all(file.closed for file in opened)


@pytest.mark.asyncio
async def test_streamed_limit_counts_actual_bytes_without_content_length(monkeypatch):
    from app import request_security

    monkeypatch.setattr(request_security, "body_limit", lambda path: 5)
    seen = []

    async def downstream(scope, receive, send):
        from starlette.exceptions import HTTPException

        assert len((await receive())["body"]) == 3
        with pytest.raises(HTTPException) as exc:
            await receive()
        assert exc.value.status_code == 413
        seen.append(True)

    chunks = iter(
        [
            {"type": "http.request", "body": b"123", "more_body": True},
            {"type": "http.request", "body": b"456", "more_body": False},
        ]
    )

    async def receive():
        return next(chunks)

    messages = []

    async def send(message):
        messages.append(message)

    await RequestSecurityMiddleware(downstream)(
        {"type": "http", "path": "/api/imports/quick", "headers": [(b"host", b"127.0.0.1:8765")]},
        receive,
        send,
    )
    assert seen == [True]
    assert messages[0]["status"] == 413
