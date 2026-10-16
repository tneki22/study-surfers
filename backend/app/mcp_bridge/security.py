import os
import secrets
from pathlib import Path

from fastapi import Request

from app.config import get_settings
from app.core.errors import DomainError


def local_origins() -> set[str]:
    return {
        f"http://{host}:{port}"
        for host in ("localhost", "127.0.0.1")
        for port in (5180, 8765, get_settings().port)
    }


def token_file() -> Path:
    return get_settings().data_dir / "mcp.token"


def local_token():
    path = token_file()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return path.read_text(encoding="utf-8").strip()
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(secrets.token_urlsafe(48))
    return path.read_text(encoding="utf-8").strip()


def authorize(request: Request):
    token = request.headers.get("authorization", "").removeprefix("Bearer ")
    origin = request.headers.get("origin")
    allowed = local_origins()
    expected = local_token()
    if (
        not expected
        or not token.isascii()
        or (origin and origin not in allowed)
        or not secrets.compare_digest(token, expected)
    ):
        raise DomainError(
            401,
            "mcp_unauthorized",
            "Нет доступа к локальному MCP. Подключите сервер заново в параметрах Study Surfers.",
        )


def check_local_origin(request: Request):
    origin = request.headers.get("origin")
    if origin and origin not in local_origins():
        raise DomainError(
            403, "local_origin_required", "Откройте параметры в локальном Study Surfers"
        )
