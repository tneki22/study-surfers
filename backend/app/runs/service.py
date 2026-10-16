from datetime import UTC

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.core.errors import DomainError, not_found
from app.core.text import norm_option
from app.decks.service import require_deck, summary
from app.models import RUN_NEWEST_FIRST, ItemStats, Question, QuizItem, Run, RunAnswer
from app.runs.schemas import DeckStats, RunDetail, RunSummary


def run_summary(run):
    return RunSummary(**{key: getattr(run, key) for key in RunSummary.model_fields})


def run_detail(session, run):
    mistakes = []
    answers = session.scalars(
        select(RunAnswer).where(RunAnswer.run_id == run.id).order_by(RunAnswer.ordinal)
    )
    for answer in answers:
        if answer.is_correct:
            continue
        snapshot = answer.prompt_snapshot
        why_wrong = next(
            (
                d["why_wrong"]
                for d in snapshot["distractors"]
                if norm_option(d["text"]) == norm_option(answer.chosen_text)
            ),
            None,
        )
        mistakes.append(
            {
                "item_id": answer.item_id,
                "prompt": snapshot["prompt"],
                "correct": snapshot["correct"],
                "chosen_text": answer.chosen_text,
                "chosen_kind": answer.chosen_kind,
                "why_wrong": why_wrong,
                "explanation": snapshot["explanation"],
                "source": snapshot["source"],
            }
        )
    return RunDetail(**run_summary(run).model_dump(), mistakes=mistakes)


def save_run(session, body):
    run_id = str(body.id)
    existing = session.get(Run, run_id)
    if existing:
        return run_detail(session, existing), False
    require_deck(session, body.deck_id)
    if body.finished_at < body.started_at:
        raise DomainError(422, "run_invalid", "Забег не может закончиться раньше начала")
    if len({a.ordinal for a in body.answers}) != len(body.answers):
        raise DomainError(422, "run_invalid", "Порядковые номера ответов должны быть уникальны")
    items = {}
    for answer in body.answers:
        item = session.get(QuizItem, answer.item_id)
        if not item or item.deck_id != body.deck_id:
            raise DomainError(422, "run_invalid", "Карточка забега не принадлежит этой колоде")
        correct = norm_option(answer.chosen_text) == norm_option(item.correct)
        option = next(
            (
                d
                for d in item.distractors
                if norm_option(d["text"]) == norm_option(answer.chosen_text)
            ),
            None,
        )
        expected_kind = "correct" if correct else option["kind"] if option else "timeout"
        if (
            answer.correct != correct
            or answer.chosen_kind != expected_kind
            or (expected_kind == "timeout" and answer.chosen_text.strip())
        ):
            raise DomainError(422, "run_invalid", "Ответ и его тип не соответствуют карточке")
        items[answer.item_id] = item
    run = Run(
        id=run_id,
        deck_id=body.deck_id,
        settings=body.settings.model_dump(),
        score=body.score,
        distance=body.distance,
        max_streak=body.max_streak,
        correct_count=sum(a.correct for a in body.answers),
        wrong_count=sum(not a.correct for a in body.answers),
        duration_ms=int((body.finished_at - body.started_at).total_seconds() * 1000),
        started_at=body.started_at.astimezone(UTC),
        finished_at=body.finished_at.astimezone(UTC),
    )
    session.add(run)
    try:
        session.flush()
        for answer in sorted(body.answers, key=lambda a: a.ordinal):
            item = items[answer.item_id]
            snapshot = {
                key: getattr(item, key)
                for key in ("prompt", "correct", "distractors", "explanation", "source")
            }
            session.add(
                RunAnswer(
                    run_id=run.id,
                    item_id=item.id,
                    ordinal=answer.ordinal,
                    chosen_text=answer.chosen_text,
                    chosen_kind=answer.chosen_kind,
                    is_correct=answer.correct,
                    reaction_ms=answer.reaction_ms,
                    prompt_snapshot=snapshot,
                )
            )
            stats = session.get(ItemStats, item.id)
            if not stats:
                stats = ItemStats(
                    item_id=item.id, deck_id=body.deck_id, seen=0, correct=0, wrong=0, streak=0
                )
                session.add(stats)
            stats.seen += 1
            stats.correct += int(answer.correct)
            stats.wrong += int(not answer.correct)
            stats.streak = stats.streak + 1 if answer.correct else 0
            stats.last_seen_at = run.finished_at
            if not answer.correct:
                stats.last_wrong_at = run.finished_at
        session.commit()
    except IntegrityError:
        session.rollback()
        existing = session.get(Run, run_id)
        if not existing:
            raise
        return run_detail(session, existing), False
    return run_detail(session, run), True


def require_run(session, run_id):
    run = session.get(Run, run_id)
    if not run:
        raise not_found("Забег не найден")
    return run


def deck_stats(session, deck_id):
    deck = require_deck(session, deck_id)
    deck_summary = summary(session, deck)
    rows = session.execute(
        select(ItemStats, Question.section)
        .join(QuizItem, QuizItem.id == ItemStats.item_id)
        .outerjoin(Question, Question.id == QuizItem.question_id)
        .where(ItemStats.deck_id == deck_id, QuizItem.enabled)
    ).all()
    sections = {}
    for stats, section in rows:
        record = sections.setdefault(section, {"seen": 0, "correct": 0, "count": 0})
        record["seen"] += stats.seen
        record["correct"] += stats.correct
        record["count"] += 1
    last_run = session.scalar(select(Run).where(Run.deck_id == deck_id).order_by(*RUN_NEWEST_FIRST))
    return DeckStats(
        item_count=deck_summary.enabled_item_count,
        seen_count=sum(s.seen > 0 for s, _ in rows),
        mastered_count=sum(s.streak >= 2 for s, _ in rows),
        weak_count=deck_summary.weak_count,
        best_score=deck_summary.best_score,
        runs_count=deck_summary.runs_count,
        last_run=run_summary(last_run) if last_run else None,
        by_section=[
            {
                "section": k,
                "accuracy": v["correct"] / v["seen"] if v["seen"] else 0,
                "count": v["count"],
            }
            for k, v in sections.items()
        ],
    )
