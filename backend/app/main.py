from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from starlette.exceptions import HTTPException

from app import (
    __version__,
    models,  # noqa: F401
)
from app.ai import models as ai_models  # noqa: F401
from app.ai.client import AiClient
from app.ai.router import router as ai_router
from app.ai.subscriptions import close_subscriptions
from app.ai.subscriptions import router as subscriptions_router
from app.config import ROOT, get_settings
from app.core.errors import DomainError
from app.core.logging import close_logging, configure_logging
from app.db import SCHEMA_VERSION, init_db, session_factory
from app.decks.export import seed_demo
from app.decks.router import router as decks_router
from app.flashcards.router import router as flashcards_router
from app.mcp_bridge import models as mcp_models  # noqa: F401
from app.mcp_bridge.router import router as mcp_router
from app.mcp_bridge.security import local_token
from app.mcp_bridge.setup import router as mcp_setup_router
from app.parsing.lexicon import index_text
from app.pipeline.jobs import get_manager, recover_jobs
from app.pipeline.router import router as pipeline_router
from app.remote_access import guard_remote
from app.request_security import RequestSecurityMiddleware
from app.runs.router import router as runs_router
from app.tentex.router import router as tentex_router


@asynccontextmanager
async def lifespan(app):
    configure_logging()
    init_db()
    local_token()
    recover_jobs()
    index_text("Проверка морфологии")
    if get_settings().seed_demo:
        with session_factory()() as session:
            seed_demo(session)
    try:
        yield
    finally:
        await get_manager().close()
        await close_subscriptions()
        close_logging()


class ErrorResponse(BaseModel):
    detail: str
    code: str
    context: dict


app = FastAPI(
    title="Study Surfers",
    version=__version__,
    lifespan=lifespan,
    generate_unique_id_function=lambda route: route.name,
    responses={
        code: {"model": ErrorResponse}
        for code in (401, 403, 404, 409, 413, 415, 422, 429, 500, 502, 503, 504)
    },
)
app.middleware("http")(guard_remote)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5180", "http://127.0.0.1:5180"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(RequestSecurityMiddleware)


@app.exception_handler(DomainError)
async def domain_error(request: Request, exc: DomainError):
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": exc.detail, "code": exc.code, "context": exc.context},
    )


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    errors = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
    return JSONResponse(
        status_code=422,
        content={
            "detail": "Проверьте поля запроса",
            "code": "validation_error",
            "context": {"errors": errors},
        },
    )


@app.exception_handler(HTTPException)
async def http_error(request: Request, exc: HTTPException):
    if exc.status_code == 413:
        return JSONResponse(
            status_code=413,
            content={
                "detail": "Превышен допустимый размер запроса",
                "code": "import_too_large",
                "context": {},
            },
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "detail": "Путь не найден"
            if exc.status_code == 404
            else "Запрос не может быть выполнен",
            "code": "not_found" if exc.status_code == 404 else "http_error",
            "context": {},
        },
    )


class Health(BaseModel):
    status: str = "ok"
    version: str
    schema_version: int
    ai_ready: bool


@app.get("/api/health", response_model=Health)
def health():
    try:
        AiClient().resolve("generate")
        ready = True
    except DomainError:
        ready = False
    return Health(version=__version__, schema_version=SCHEMA_VERSION, ai_ready=ready)


app.include_router(decks_router)
app.include_router(runs_router)
app.include_router(ai_router)
app.include_router(subscriptions_router)
app.include_router(mcp_router)
app.include_router(mcp_setup_router)
app.include_router(pipeline_router)
app.include_router(tentex_router)
app.include_router(flashcards_router)


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str):
    if path == "api" or path.startswith("api/"):
        raise DomainError(404, "not_found", "Путь API не найден")
    dist = (ROOT / "frontend" / "dist").resolve()
    candidate = (dist / path).resolve()
    if candidate.is_relative_to(dist) and candidate.is_file():
        return FileResponse(candidate)
    index: Path = dist / "index.html"
    if index.exists():
        return FileResponse(index)
    raise DomainError(
        404, "frontend_not_built", "Интерфейс ещё не собран. Запустите Study Surfers.cmd"
    )
