from collections import Counter

from app.core.text import visible_len
from app.flashcards.convert import Card, mapping_for, one_line, shorten
from app.flashcards.reader import FlashcardSource, clean_field
from app.flashcards.schemas import (
    DeckCountRead,
    FlashcardOptions,
    FlashcardPreview,
    NoteTypeRead,
    PlanCounts,
    PlannedCardRead,
    ReasonRead,
)
from app.models import Deck, GenerationJob, Question, QuizItem, uid


def counts(cards: list[Card]) -> PlanCounts:
    by_plan = Counter(c.plan for c in cards)
    return PlanCounts(
        total=len(cards), ready=by_plan["ready"], ai=by_plan["ai"], skipped=by_plan["skip"]
    )


def _sample(card: Card) -> PlannedCardRead:
    item = card.item or {}
    return PlannedCardRead(
        plan=card.plan,
        front=shorten(one_line(card.front), 200),
        back=shorten(one_line(card.back, "; "), 200),
        prompt=item.get("prompt"),
        correct=item.get("correct"),
        distractors=[d["text"] for d in item.get("distractors", [])],
        explanation=item.get("explanation", ""),
        reason=None if card.plan == "ready" else card.reason,
    )


def _samples(cards: list[Card]) -> list[PlannedCardRead]:
    """Пример из каждой группы: что готово сразу, что доделает ИИ и что пропущено."""
    picked = [
        *[c for c in cards if c.plan == "ready"][:3],
        *[c for c in cards if c.plan == "ai"][:2],
        *[c for c in cards if c.plan == "skip"][:2],
    ]
    return [_sample(c) for c in picked]


def preview(
    source: FlashcardSource, options: FlashcardOptions, cards: list[Card], *, filename, ai_ready
) -> FlashcardPreview:
    reasons = Counter((c.plan, c.reason) for c in cards if c.plan in ("ai", "skip"))
    note_types = []
    for note_type in source.note_types.values():
        examples = [
            [shorten(one_line(clean_field(v)), 80) for v in note.fields]
            for note in source.notes
            if note.note_type == note_type.id
        ][:3]
        note_types.append(
            NoteTypeRead(
                id=note_type.id,
                name=note_type.name,
                fields=note_type.fields,
                count=note_type.count,
                cloze=note_type.cloze,
                mapping=mapping_for(note_type, options),
                examples=examples,
            )
        )
    return FlashcardPreview(
        filename=filename,
        format=source.format,
        title=options.title or source.title or "Карточки",
        note_types=note_types,
        decks=[DeckCountRead(name=k, count=v) for k, v in sorted(source.decks.items())],
        counts=counts(cards),
        reasons=[
            ReasonRead(plan=plan, reason=reason, count=count)
            for (plan, reason), count in reasons.most_common()
        ],
        samples=_samples(cards),
        ai_ready=ai_ready,
    )


def create_deck(session, title: str, cards: list[Card]) -> tuple[Deck, GenerationJob | None]:
    """Готовые карточки пишутся сразу; остальные становятся вопросами для задачи генерации."""
    deck = Deck(id=uid(), title=title[:200], source_kind="flashcards", options={"language": "ru"})
    session.add(deck)
    session.flush()
    seq = 0
    pending = {}
    for ordinal, card in enumerate((c for c in cards if c.plan in ("ready", "ai")), 1):
        question = Question(
            id=uid(),
            deck_id=deck.id,
            ordinal=ordinal,
            number_label=str(ordinal),
            section=card.section,
            text=one_line(card.front)[:2000],
            answer_text=card.back + (f"\n\n{card.extra}" if card.extra else ""),
            match_method="flashcard",
            items_target=1,
            status="done" if card.plan == "ready" else "pending",
        )
        session.add(question)
        if card.plan == "ready":
            seq += 1
            session.add(
                QuizItem(
                    id=uid(),
                    deck_id=deck.id,
                    question_id=question.id,
                    seq=seq,
                    gen_meta={"import": "flashcards"},
                    **card.item,
                )
            )
        else:
            front = one_line(card.front)
            back = card.ai_back + (f"\n\nПояснение: {card.extra}" if card.extra else "")
            pending[question.id] = [
                {
                    "front": front if visible_len(front) <= 800 else shorten(front, 800),
                    "back": back,
                    "source": "flashcard",
                }
            ]
    job = None
    # Карточки для модели живут там же, где карточки Tentex: задача генерации их уже понимает.
    deck.options = {
        "language": "ru",
        "seq_high_water": seq,
        **({"tentex_cards": pending} if pending else {}),
    }
    if pending:
        job = GenerationJob(
            id=uid(), deck_id=deck.id, kind="flashcard_import", state="queued", total=len(pending)
        )
        session.add(job)
    session.commit()
    return deck, job
