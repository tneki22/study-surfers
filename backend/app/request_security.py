"""Граница локального HTTP: доверенные адреса, источник браузера и размер тела."""

from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.exceptions import HTTPException
from starlette.responses import JSONResponse

from app.config import get_settings
from app.mcp_bridge.security import local_origins

LOCAL_HOSTS = {"localhost", "127.0.0.1", "::1"}
MIB = 1024 * 1024


def body_limit(path: str) -> int:
    path = path.rstrip("/")
    # Пакет из 20 документов по 30 МБ плюс multipart-заголовки.
    if path == "/api/imports/quick":
        return 602 * MIB
    if path == "/api/imports/flashcards":
        return 202 * MIB
    if path == "/api/decks/import":
        return 32 * MIB
    return 16 * MIB


def authority(value: str):
    try:
        parsed = urlsplit("//" + value)
        if (
            not parsed.hostname
            or parsed.username is not None
            or parsed.password is not None
            or parsed.path
            or parsed.query
            or parsed.fragment
        ):
            return None
        return parsed.hostname.lower(), parsed.port
    except ValueError:
        return None


def error(status: int, code: str, detail: str):
    return JSONResponse(status_code=status, content={"detail": detail, "code": code, "context": {}})


class RequestSecurityMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = Headers(scope=scope)
        hosts = headers.getlist("host")
        host = authority(hosts[0]) if len(hosts) == 1 else None
        public = get_settings().public_host
        if not host or host[0] not in LOCAL_HOSTS | ({public.lower()} if public else set()):
            return await error(403, "untrusted_host", "Этот адрес не разрешён для Study Surfers")(
                scope, receive, send
            )
        path = scope["path"]
        if path == "/api" or path.startswith("/api/"):
            origin = headers.get("origin")
            # Публичный туннель завершает HTTPS перед локальным HTTP-сервером.
            allowed = local_origins() if host[0] in LOCAL_HOSTS else set()
            schemes = ("http",) if host[0] in LOCAL_HOSTS else ("https",)
            allowed.update(f"{scheme}://{hosts[0].lower()}" for scheme in schemes)
            if (origin is not None and origin not in allowed) or (
                origin is None and headers.get("sec-fetch-site") == "cross-site"
            ):
                return await error(
                    403, "request_origin_forbidden", "Откройте запрос из самого Study Surfers"
                )(scope, receive, send)
        limit = body_limit(path)
        try:
            length = int(headers.get("content-length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > limit:
            return await error(413, "import_too_large", "Превышен допустимый размер запроса")(
                scope, receive, send
            )
        received = 0
        overflow = False

        async def limited_receive():
            nonlocal received, overflow
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > limit:
                    overflow = True
                    # Starlette закрывает spooled-файлы и при ошибке чтения потока.
                    raise HTTPException(413)
            return message

        async def limited_send(message):
            # FastAPI может преобразовать ошибку чтения тела в 400. Сохраняем
            # единый ответ 413 после того, как парсер закроет временные файлы.
            if not overflow:
                await send(message)

        try:
            await self.app(scope, limited_receive, limited_send)
        except Exception:
            if not overflow:
                raise
        if overflow:
            await error(413, "import_too_large", "Превышен допустимый размер запроса")(
                scope, receive, send
            )
