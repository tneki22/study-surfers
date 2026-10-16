import asyncio
import json
from typing import Annotated

from fastapi import APIRouter, File, Form, Response, UploadFile
from pydantic import ValidationError

from app.ai.client import AiClient
from app.core.errors import DomainError
from app.db import session_factory
from app.flashcards import service
from app.flashcards.convert import plan_cards
from app.flashcards.reader import read_flashcards
from app.flashcards.schemas import FlashcardImportRead, FlashcardOptions, FlashcardPreview

router = APIRouter(prefix="/api", tags=["Импорт и задачи"])

MAX_BYTES = 200 * 1024 * 1024


def _ai_ready() -> bool:
    try:
        AiClient().resolve("generate")
        return True
    except DomainError:
        return False


@router.post(
    "/imports/flashcards",
    response_model=FlashcardPreview | FlashcardImportRead,
    responses={201: {"model": FlashcardImportRead}},
)
async def import_flashcards(
    response: Response,
    file: Annotated[UploadFile, File()],
    options: Annotated[str, Form()] = "{}",
    dry_run: bool = False,
):
    """Карточки Anki (.apkg, .colpkg) или таблица (.txt, .tsv, .csv: Anki, Quizlet, Excel).

    `dry_run=true` ничего не сохраняет: показывает поля, план (готово / ИИ / пропуск) и примеры.
    """
    try:
        parsed = FlashcardOptions.model_validate(json.loads(options))
    except (ValueError, ValidationError) as exc:
        raise DomainError(
            422,
            "validation_error",
            "Параметры импорта должны быть корректным JSON",
            {"errors": [{"msg": str(exc)}]},
        ) from exc
    filename = file.filename or "cards"
    data = await file.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise DomainError(
            413,
            "import_too_large",
            "Файл больше 200 МБ: экспортируйте колоду из Anki без медиафайлов",
            {"filename": filename},
        )
    source = await asyncio.to_thread(read_flashcards, data, filename)
    ai_ready = _ai_ready()
    if parsed.mode == "ai" and not ai_ready:
        raise DomainError(409, "ai_model_not_configured", "Настройте модель для генерации карточек")
    cards = await asyncio.to_thread(plan_cards, source, parsed, ai_ready=ai_ready)
    if dry_run:
        return service.preview(source, parsed, cards, filename=filename, ai_ready=ai_ready)
    summary = service.counts(cards)
    if not summary.ready and not summary.ai:
        raise DomainError(
            422,
            "flashcards_nothing",
            "Ни одна карточка не подошла: выберите другие поля или режим с ИИ",
        )
    with session_factory()() as session:
        deck, job = service.create_deck(session, parsed.title or source.title or "Карточки", cards)
        deck_id, job_id = deck.id, job.id if job else None
    if job_id:
        from app.pipeline.jobs import start_job

        start_job(job_id)
    response.status_code = 201
    return FlashcardImportRead(deck_id=deck_id, job_id=job_id, counts=summary)
