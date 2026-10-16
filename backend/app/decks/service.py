import logging
from pathlib import Path

from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.core.errors import not_found
from app.decks.schemas import DeckDetail, DeckSummary, QuizItemRead
from app.models import (
    RUN_NEWEST_FIRST,
    Deck,
    GenerationJob,
    ItemStats,
    Question,
    QuizItem,
    Run,
    RunAnswer,
    SourceDoc,
)

ACTIVE_STATES = (
    "queued",
    "extracting",
    "structuring",
    "awaiting_confirm",
    "awaiting_executor",
    "generating",
)
INTERNAL_OPTIONS = frozenset(
    ("imports", "source_blocks", "tentex_cards", "seq_high_water", "auto_title")
)


def public_options(options):
    return {key: value for key, value in options.items() if key not in INTERNAL_OPTIONS}


def require_deck(session: Session, deck_id: str) -> Deck:
    deck = session.get(Deck, deck_id)
    if not deck:
        raise not_found("Колода не найдена")
    return deck


def require_item(session: Session, item_id: str) -> QuizItem:
    item = session.get(QuizItem, item_id)
    if not item:
        raise not_found("Карточка не найдена")
    return item


def weak_condition():
    return ((ItemStats.wrong > 0) & (ItemStats.streak < 2)) | (
        (ItemStats.seen > 0) & (ItemStats.correct * 1.0 / ItemStats.seen < 0.6)
    )


def active_job(session, deck_id):
    return session.scalar(
        select(GenerationJob)
        .where(GenerationJob.deck_id == deck_id, GenerationJob.state.in_(ACTIVE_STATES))
        .order_by(GenerationJob.created_at.desc())
    )


def summary(session, deck: Deck) -> DeckSummary:
    count = session.scalar(
        select(func.count()).select_from(QuizItem).where(QuizItem.deck_id == deck.id)
    )
    enabled = session.scalar(
        select(func.count())
        .select_from(QuizItem)
        .where(QuizItem.deck_id == deck.id, QuizItem.enabled)
    )
    questions = session.scalar(
        select(func.count()).select_from(Question).where(Question.deck_id == deck.id)
    )
    job = active_job(session, deck.id)
    run_count, best, last = session.execute(
        select(func.count(Run.id), func.max(Run.score), func.max(Run.finished_at)).where(
            Run.deck_id == deck.id
        )
    ).one()
    weak = session.scalar(
        select(func.count())
        .select_from(ItemStats)
        .join(QuizItem, QuizItem.id == ItemStats.item_id)
        .where(ItemStats.deck_id == deck.id, weak_condition(), QuizItem.enabled)
    )
    failed = session.scalar(
        select(func.count())
        .select_from(Question)
        .where(Question.deck_id == deck.id, Question.status == "failed")
    )
    status = "generating" if job else "ready" if enabled else "failed" if failed else "empty"
    return DeckSummary(
        id=deck.id,
        title=deck.title,
        status=status,
        source_kind=deck.source_kind,
        item_count=count,
        enabled_item_count=enabled,
        question_count=questions,
        active_job_id=job.id if job else None,
        runs_count=run_count,
        best_score=best,
        last_played_at=last,
        weak_count=weak,
        created_at=deck.created_at,
        updated_at=deck.updated_at,
    )


def best_by_setup(session, deck_id: str) -> list[dict]:
    best: dict[tuple[str, str], int] = {}
    for settings, score in session.execute(
        select(Run.settings, Run.score).where(Run.deck_id == deck_id)
    ):
        key = (settings.get("world", "classic"), settings.get("obstacles", "normal"))
        best[key] = max(best.get(key, score), score)
    return [
        {"world": world, "obstacles": obstacles, "score": score}
        for (world, obstacles), score in sorted(best.items())
    ]


def detail(session, deck: Deck) -> DeckDetail:
    questions = list(session.scalars(select(Question).where(Question.deck_id == deck.id)))
    sources = list(session.scalars(select(SourceDoc).where(SourceDoc.deck_id == deck.id)))
    return DeckDetail(
        **summary(session, deck).model_dump(),
        description=deck.description,
        options=public_options(deck.options),
        questions_summary={
            "total": len(questions),
            "done": sum(q.status == "done" for q in questions),
            "failed": sum(q.status == "failed" for q in questions),
            "pending": sum(q.status in ("pending", "generating") for q in questions),
        },
        sources=[
            {
                "id": s.id,
                "filename": s.filename,
                "kind": s.kind,
                "role": s.role,
                "char_count": len(s.text),
                "warnings": s.warnings,
            }
            for s in sources
        ],
        best_by_setup=best_by_setup(session, deck.id),
    )


def item_read(session, item: QuizItem) -> QuizItemRead:
    question = session.get(Question, item.question_id) if item.question_id else None
    stats = session.get(ItemStats, item.id)
    return QuizItemRead(
        **{
            key: getattr(item, key)
            for key in (
                "id",
                "deck_id",
                "question_id",
                "seq",
                "prompt",
                "correct",
                "distractors",
                "explanation",
                "source",
                "evidence_quote",
                "enabled",
                "edited",
                "created_at",
                "updated_at",
            )
        },
        question_ordinal=question.ordinal if question else None,
        section=question.section if question else None,
        stats={key: getattr(stats, key) for key in ("seen", "correct", "streak", "last_wrong_at")}
        if stats
        else None,
    )


def item_query(session, deck_id, filter_name, include_disabled):
    query = select(QuizItem).where(QuizItem.deck_id == deck_id)
    if not include_disabled:
        query = query.where(QuizItem.enabled)
    if filter_name == "weak":
        query = query.join(ItemStats).where(weak_condition())
    elif filter_name == "last_mistakes":
        run = session.scalar(select(Run).where(Run.deck_id == deck_id).order_by(*RUN_NEWEST_FIRST))
        query = query.where(
            QuizItem.id.in_(
                select(RunAnswer.item_id).where(
                    RunAnswer.run_id == (run.id if run else ""), ~RunAnswer.is_correct
                )
            )
        )
    return query


def delete_deck(session, deck):
    uploads = (get_settings().data_dir / "uploads").resolve()
    paths = [
        Path(value).resolve()
        for config in deck.options.get("imports", {}).values()
        for value in config.get("upload_paths", {}).values()
    ]
    session.execute(delete(Deck).where(Deck.id == deck.id))
    session.commit()
    for path in paths:
        if path.is_relative_to(uploads):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                logging.getLogger("study_surfers").exception("Не удалось удалить исходник %s", path)
