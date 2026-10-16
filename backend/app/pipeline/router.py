import asyncio
import hashlib
import json
from dataclasses import asdict
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, File, Form, Response, UploadFile
from pydantic import ValidationError

from app.ai.client import AiClient
from app.config import get_settings
from app.core.errors import DomainError
from app.db import session_factory
from app.decks.schemas import QuizItemRead
from app.decks.service import item_read, require_deck, require_item
from app.models import Question
from app.parsing.extract import ExtractedDocument, extract_document, extract_paste
from app.parsing.source_markup import SUPPORTED_KINDS, SUPPORTED_LABEL
from app.pipeline import jobs
from app.pipeline.generate import ensure_batch, generate_question
from app.pipeline.prompts import DEFAULT_LEARNER_PRESET_ID, LEARNER_PRESETS, LEARNER_PROMPT_MAX
from app.pipeline.schemas import (
    DryRunRead,
    ImportOptions,
    ImportRead,
    JobRead,
    JobStarted,
    LearnerPresetsRead,
    RegenerateItem,
    RegenerateQuestion,
)
from app.pipeline.structure import structure_documents

router = APIRouter(prefix="/api", tags=["Импорт и задачи"])


def extract_client():
    client = AiClient()
    try:
        client.resolve("extract")
        return client
    except DomainError:
        return None


def validate_uploads(files, text):
    if len(files) > 20:
        raise DomainError(413, "import_too_large", "Можно загрузить не более 20 файлов")
    if not files and not (text or "").strip():
        raise DomainError(422, "import_empty", "Добавьте файлы или вставьте текст")
    for file in files:
        suffix = (file.filename or "").rsplit(".", 1)[-1].casefold()
        if suffix not in SUPPORTED_KINDS:
            detail = (
                "Сохраните документ DOC как DOCX"
                if suffix == "doc"
                else f"Поддерживаются {SUPPORTED_LABEL}"
            )
            raise DomainError(415, "import_unsupported_type", detail, {"filename": file.filename})
        if file.size is not None and file.size > 30 * 1024 * 1024:
            raise DomainError(
                413,
                "import_too_large",
                "Размер файла не должен превышать 30 МБ",
                {"filename": file.filename},
            )


async def read_uploads(files, text, options, *, defer_extract=False):
    validate_uploads(files, text)
    documents = []
    try:
        for file in files:
            filename = file.filename or "Без имени"
            suffix = filename.rsplit(".", 1)[-1].casefold()
            data = await file.read(30 * 1024 * 1024 + 1)
            if len(data) > 30 * 1024 * 1024:
                raise DomainError(
                    413,
                    "import_too_large",
                    "Размер файла не должен превышать 30 МБ",
                    {"filename": filename},
                )
            if defer_extract:
                document = ExtractedDocument(
                    filename=filename,
                    kind=suffix,
                    text="",
                    blocks=[],
                    role=options.roles.get(filename),
                )
                folder = get_settings().data_dir / "uploads"
                folder.mkdir(parents=True, exist_ok=True)
                path = folder / f"upload-{document.id}.{suffix}"
                document.upload_path = str(path)
                documents.append(document)
                write = asyncio.create_task(asyncio.to_thread(path.write_bytes, data))
                try:
                    await asyncio.shield(write)
                except BaseException:
                    # Поток должен завершить запись до удаления неполного импорта.
                    await asyncio.gather(write, return_exceptions=True)
                    raise
            else:
                document = await asyncio.to_thread(
                    extract_document,
                    filename,
                    data,
                    options.roles.get(filename),
                )
                documents.append(document)
            document.sha256 = hashlib.sha256(data).hexdigest()
        if (text or "").strip():
            documents.append(extract_paste(text))
        return documents
    except BaseException:
        cleanup_uploads(documents)
        raise


def cleanup_uploads(documents):
    for document in documents:
        if document.upload_path:
            Path(document.upload_path).unlink(missing_ok=True)


@router.get("/imports/learner-presets", response_model=LearnerPresetsRead)
def learner_presets():
    """Пресеты пожеланий к карточкам для поля «Промпт» перед импортом."""
    return LearnerPresetsRead(
        default_id=DEFAULT_LEARNER_PRESET_ID,
        max_length=LEARNER_PROMPT_MAX,
        presets=LEARNER_PRESETS,
    )


@router.post(
    "/imports/quick", response_model=DryRunRead | ImportRead, responses={202: {"model": ImportRead}}
)
async def quick_import(
    response: Response,
    files: Annotated[list[UploadFile] | None, File(alias="files[]")] = None,
    legacy_files: Annotated[list[UploadFile] | None, File(alias="files")] = None,
    text: Annotated[str | None, Form()] = None,
    options: Annotated[str, Form()] = "{}",
    dry_run: bool = False,
):
    try:
        parsed = ImportOptions.model_validate(json.loads(options))
    except (ValueError, ValidationError) as exc:
        raise DomainError(
            422,
            "validation_error",
            "Параметры импорта должны быть корректным JSON",
            {"errors": [{"msg": str(exc)}]},
        ) from exc
    uploads = [*(files or []), *(legacy_files or [])]
    validate_uploads(uploads, text)
    if not dry_run:
        try:
            AiClient().resolve("generate")
        except DomainError as exc:
            raise DomainError(
                409,
                "ai_model_not_configured",
                "Настройте модель для генерации карточек",
                {"reason": exc.code},
            ) from exc
        documents = await read_uploads(uploads, text, parsed, defer_extract=True)
        try:
            deck_id, job_id = jobs.persist_import(documents, parsed)
        except BaseException:
            cleanup_uploads(documents)
            raise
        jobs.start_job(job_id)
        response.status_code = 202
        return ImportRead(deck_id=deck_id, job_id=job_id)
    documents = await read_uploads(uploads, text, parsed)
    client = extract_client()
    questions = await structure_documents(
        documents,
        ai_client=jobs.LimitedExtractClient(client, jobs.get_manager()) if client else None,
        learner_prompt=parsed.learner_prompt,
    )
    if len(questions) > 400:
        raise DomainError(
            422, "import_question_limit", "В одном импорте допускается не более 400 вопросов"
        )
    return DryRunRead(
        questions=[asdict(q) for q in questions],
        documents=[
            {
                "id": d.id,
                "filename": d.filename,
                "kind": d.kind,
                "role": d.role,
                "char_count": len(d.text),
                "warnings": d.warnings,
            }
            for d in documents
        ],
        warnings=[w for d in documents for w in d.warnings],
    )


@router.get("/jobs/{job_id}", response_model=JobRead)
def get_job(job_id: str):
    with session_factory()() as session:
        return jobs.job_read(session, jobs.require_job(session, job_id))


@router.get("/decks/{deck_id}/jobs", response_model=list[JobRead])
def list_deck_jobs(deck_id: str, active: bool = False):
    from sqlalchemy import select

    from app.models import GenerationJob

    with session_factory()() as session:
        require_deck(session, deck_id)
        query = select(GenerationJob).where(GenerationJob.deck_id == deck_id)
        if active:
            query = query.where(GenerationJob.state.in_(jobs.ACTIVE_STATES))
        return [
            jobs.job_read(session, job)
            for job in session.scalars(query.order_by(GenerationJob.created_at.desc()))
        ]


@router.post("/jobs/{job_id}/confirm", response_model=JobRead)
async def confirm_job(job_id: str):
    jobs.transition_job(job_id, "confirm")
    jobs.start_job(job_id)
    return get_job(job_id)


@router.post("/jobs/{job_id}/cancel", response_model=JobRead)
async def cancel_job(job_id: str):
    await jobs.cancel_job(job_id)
    return get_job(job_id)


@router.post("/jobs/{job_id}/resume", response_model=JobRead)
async def resume_job(job_id: str):
    AiClient().bind_job(job_id).resolve("generate")
    jobs.transition_job(job_id, "resume")
    jobs.start_job(job_id)
    return get_job(job_id)


@router.post(
    "/decks/{deck_id}/questions/{question_id}/regenerate",
    response_model=JobStarted,
    status_code=202,
)
async def regenerate_question(deck_id: str, question_id: str, body: RegenerateQuestion):
    AiClient().resolve("generate")
    with session_factory()() as session:
        job_id = jobs.create_question_job(session, deck_id, question_id, body.items_per_question)
    jobs.start_job(job_id)
    return JobStarted(job_id=job_id)


@router.post("/items/{item_id}/regenerate", response_model=QuizItemRead)
async def regenerate_item(item_id: str, body: RegenerateItem):
    from sqlalchemy import select

    from app.decks.service import active_job
    from app.models import QuizItem

    with session_factory()() as session:
        item = require_item(session, item_id)
        if active_job(session, item.deck_id):
            raise DomainError(409, "job_state_conflict", "Дождитесь завершения генерации колоды")
        original = {
            k: getattr(item, k)
            for k in ("prompt", "correct", "explanation", "source", "evidence_quote")
        }
        learner_prompt = require_deck(session, item.deck_id).options.get("learner_prompt")
        question = session.get(Question, item.question_id) if item.question_id else None
        neighbors = None
        if question is None:
            question = Question(
                text=item.prompt, section=None, answer_text=item.explanation, items_target=1
            )
        else:
            neighbors = jobs.program_neighbors(session, question)
            session.expunge(question)
        avoid = list(
            session.scalars(
                select(QuizItem.prompt).where(
                    QuizItem.deck_id == item.deck_id, QuizItem.id != item_id
                )
            )
        )
    try:
        batch = await asyncio.wait_for(
            generate_question(
                AiClient(),
                question,
                target=1,
                avoid=avoid,
                mode=body.mode,
                original=original,
                allow_repair=False,
                learner_prompt=learner_prompt,
                neighbors=neighbors,
            ),
            timeout=120,
        )
    except TimeoutError as exc:
        raise DomainError(504, "ai_timeout", "Модель не ответила за 120 секунд") from exc
    value = ensure_batch(batch)
    with session_factory()() as session:
        item = require_item(session, item_id)
        for key, content in value.items():
            setattr(item, key, content)
        item.edited = False
        session.commit()
        return item_read(session, item)
