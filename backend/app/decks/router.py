from typing import Annotated, Literal
from urllib.parse import quote

from fastapi import APIRouter, Depends, File, Query, Response, UploadFile
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.errors import DomainError
from app.core.text import slug
from app.db import get_session, session_factory
from app.decks import service
from app.decks.export import (
    _demo_content,
    export_anki,
    export_deck,
    import_deck,
    parse_deck_file,
)
from app.decks.schemas import (
    DeckCreate,
    DeckDetail,
    DeckFile,
    DeckPatch,
    DeckSummary,
    ItemPage,
    ItemPatch,
    QuestionRead,
    QuizItemRead,
)
from app.models import Deck, Question, QuizItem
from app.pipeline.validate import validate_item

router = APIRouter(prefix="/api", tags=["Колоды"])
DB = Annotated[Session, Depends(get_session)]


@router.get("/decks", response_model=list[DeckSummary])
def list_decks(session: DB):
    return [
        service.summary(session, d)
        for d in session.scalars(select(Deck).order_by(Deck.updated_at.desc()))
    ]


@router.post("/decks", response_model=DeckDetail, status_code=201)
def create_deck(body: DeckCreate, session: DB):
    deck = Deck(**body.model_dump())
    session.add(deck)
    session.commit()
    return service.detail(session, deck)


@router.post("/decks/import", response_model=DeckDetail, status_code=201)
async def import_deck_file(file: UploadFile = File(...)):
    data = await file.read(30 * 1024 * 1024 + 1)
    if len(data) > 30 * 1024 * 1024:
        raise DomainError(413, "import_too_large", "Файл колоды больше 30 МБ")
    content = parse_deck_file(data)
    with session_factory()() as session:
        deck = import_deck(session, content)
        return service.detail(session, deck)


@router.get("/decks/{deck_id}", response_model=DeckDetail)
def get_deck(deck_id: str, session: DB):
    return service.detail(session, service.require_deck(session, deck_id))


@router.patch("/decks/{deck_id}", response_model=DeckDetail)
def update_deck(deck_id: str, body: DeckPatch, session: DB):
    deck = service.require_deck(session, deck_id)
    for key, value in body.model_dump(exclude_none=True, exclude_unset=True).items():
        setattr(deck, key, value)
    session.commit()
    return service.detail(session, deck)


@router.delete("/decks/{deck_id}", status_code=204, response_model=None)
async def delete_deck(deck_id: str):
    with session_factory()() as session:
        service.require_deck(session, deck_id)
        job = service.active_job(session, deck_id)
        job_id = job.id if job else None
    if job_id:
        from app.pipeline.jobs import cancel_job

        try:
            await cancel_job(job_id)
        except DomainError as exc:
            if exc.code != "job_state_conflict":
                raise
    with session_factory()() as session:
        service.delete_deck(session, service.require_deck(session, deck_id))
    return Response(status_code=204)


@router.get("/decks/{deck_id}/questions", response_model=list[QuestionRead])
def list_questions(deck_id: str, session: DB):
    service.require_deck(session, deck_id)
    result = []
    for q in session.scalars(
        select(Question).where(Question.deck_id == deck_id).order_by(Question.ordinal)
    ):
        result.append(
            QuestionRead(
                **{
                    k: getattr(q, k)
                    for k in (
                        "id",
                        "ordinal",
                        "number_label",
                        "section",
                        "text",
                        "match_method",
                        "status",
                        "error",
                    )
                },
                has_answer=bool(q.answer_text),
                item_count=session.scalar(
                    select(func.count()).select_from(QuizItem).where(QuizItem.question_id == q.id)
                ),
            )
        )
    return result


@router.get("/decks/{deck_id}/items", response_model=ItemPage)
def list_items(
    deck_id: str,
    session: DB,
    since: int = Query(0, ge=0),
    filter: Literal["all", "weak", "last_mistakes"] = "all",
    include_disabled: bool = False,
    limit: int = Query(500, ge=1, le=500),
):
    service.require_deck(session, deck_id)
    query = service.item_query(session, deck_id, filter, include_disabled)
    total = session.scalar(select(func.count()).select_from(query.subquery()))
    items = list(
        session.scalars(query.where(QuizItem.seq > since).order_by(QuizItem.seq).limit(limit))
    )
    return ItemPage(
        items=[service.item_read(session, i) for i in items],
        next_since=max([since] + [i.seq for i in items]),
        total_ready=total,
        job_active=service.active_job(session, deck_id) is not None,
    )


@router.patch("/items/{item_id}", response_model=QuizItemRead)
def update_item(item_id: str, body: ItemPatch, session: DB):
    item = service.require_item(session, item_id)
    values = body.model_dump(exclude_unset=True, exclude_none=True)
    candidate = {
        k: getattr(item, k)
        for k in (
            "prompt",
            "correct",
            "distractors",
            "explanation",
            "source",
            "evidence_quote",
            "enabled",
        )
    }
    candidate.update(values)
    if candidate["enabled"] and not _demo_content(candidate):
        question = session.get(Question, item.question_id) if item.question_id else None
        _, issues = validate_item(
            candidate, question.answer_text if question else None, check_quote=True
        )
        if issues:
            raise DomainError(
                422, "item_invalid", "Карточка не прошла проверку", {"issues": issues}
            )
    for key, value in values.items():
        setattr(item, key, value)
    item.edited = True
    session.commit()
    return service.item_read(session, item)


@router.delete("/items/{item_id}", status_code=204, response_model=None)
def delete_item(item_id: str, session: DB):
    session.delete(service.require_item(session, item_id))
    session.commit()
    return Response(status_code=204)


@router.get(
    "/decks/{deck_id}/export",
    response_model=DeckFile,
    responses={200: {"content": {"text/plain": {}}}},
)
def download_deck(deck_id: str, session: DB, format: Literal["ssdeck", "anki"] = "ssdeck"):
    """`ssdeck` — полная копия колоды для Study Surfers; `anki` — таблица для Anki и Quizlet."""
    deck = service.require_deck(session, deck_id)
    if format == "anki":
        return Response(
            export_anki(session, deck),
            media_type="text/plain; charset=utf-8",
            headers={"Content-Disposition": attachment(deck.title, "anki.txt")},
        )
    content: DeckFile = export_deck(session, deck)
    return Response(
        content.model_dump_json(indent=2),
        media_type="application/json",
        headers={"Content-Disposition": attachment(deck.title, "ssdeck.json")},
    )


def attachment(title: str, suffix: str) -> str:
    return f"attachment; filename*=UTF-8''{quote(slug(title))}.{suffix}"
