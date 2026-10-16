"""Ограничения для запросов, пришедших через публичный туннель (ngrok).

Игра, колоды и генерация доступны по ссылке всем. Ключи провайдеров, лимиты,
подписки, MCP и Tentex меняются только с самого компьютера.
"""

from __future__ import annotations

import re

from fastapi import Request
from fastapi.responses import JSONResponse

LOCAL_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1", "testserver"}

_BLOCKED = [
    (None, re.compile(r"^/api/tentex(/|$)")),
    (None, re.compile(r"^/api/mcp(/|$)")),
    ("write", re.compile(r"^/api/settings/ai/(mcp|subscriptions)(/|$)")),
    ("write", re.compile(r"^/api/settings/ai/?$")),
    ("write", re.compile(r"^/api/settings/ai/providers/?$")),
    ("write", re.compile(r"^/api/settings/ai/providers/[^/]+/?$")),
    ("write", re.compile(r"^/api/settings/ai/providers/[^/]+/credential/?$")),
]


def is_remote(request: Request) -> bool:
    host = request.headers.get("host", "").lower()
    hostname = host.rsplit(":", 1)[0] if not host.startswith("[") else host.split("]")[0] + "]"
    return bool(host) and hostname not in LOCAL_HOSTS


def is_blocked(method: str, path: str) -> bool:
    write = method.upper() not in {"GET", "HEAD", "OPTIONS"}
    return any(pattern.match(path) and (kind is None or write) for kind, pattern in _BLOCKED)


async def guard_remote(request: Request, call_next):
    if is_remote(request) and is_blocked(request.method, request.url.path):
        return JSONResponse(
            status_code=403,
            content={
                "detail": "Это меняется только на компьютере, где запущен Study Surfers",
                "code": "local_only",
                "context": {},
            },
        )
    return await call_next(request)
