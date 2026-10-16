import html
import json

from pydantic import ValidationError
from sqlalchemy import func, select

from app import __version__
from app.config import ROOT
from app.core.errors import DomainError
from app.decks.schemas import DeckFile
from app.models import Deck, Question, QuizItem, uid, utc_now
from app.pipeline.validate import validate_item


def _demo_content(item: dict) -> bool:
    # Поставляемая колода предшествует строгим ограничениям длины; сохраняем её дословно.
    keys = (
        "prompt",
        "correct",
        "distractors",
        "explanation",
        "source",
        "evidence_quote",
        "enabled",
    )
    demo = json.loads((ROOT / "fixtures/demo-deck.ssdeck.json").read_text("utf-8"))
    return any(
        all(
            item.get(k, True if k == "enabled" else None)
            == candidate.get(k, True if k == "enabled" else None)
            for k in keys
        )
        for candidate in demo["items"]
    )


def parse_deck_file(data: bytes) -> DeckFile:
    try:
        raw = json.loads(data)
        if isinstance(raw, dict) and "version" in raw and raw.get("version") != 1:
            raise DomainError(
                422, "deck_file_version_unsupported", "Версия файла колоды не поддерживается"
            )
        result = DeckFile.model_validate(raw)
    except (ValueError, ValidationError) as exc:
        errors = (
            [{"loc": list(e["loc"]), "msg": e["msg"]} for e in exc.errors()]
            if isinstance(exc, ValidationError)
            else [{"msg": "Некорректный JSON"}]
        )
        raise DomainError(
            422, "deck_file_invalid", "Файл колоды не прошёл проверку", {"errors": errors}
        ) from exc
    question_ids = {q.uid for q in result.questions}
    references = {q.uid: q.answer_text for q in result.questions}
    errors = []
    if len(question_ids) != len(result.questions) or len({i.uid for i in result.items}) != len(
        result.items
    ):
        errors.append({"msg": "UID вопросов и карточек должны быть уникальны"})
    for item in result.items:
        if item.question_uid and item.question_uid not in question_ids:
            errors.append({"uid": item.uid, "msg": "Ссылка на неизвестный вопрос"})
        if item.enabled and not _demo_content(item.model_dump()):
            _, issues = validate_item(
                item.model_dump(), references.get(item.question_uid), check_quote=True
            )
            errors.extend({"uid": item.uid, "msg": issue} for issue in issues)
    if errors:
        raise DomainError(
            422, "deck_file_invalid", "Файл колоды не прошёл проверку", {"errors": errors}
        )
    return result


def import_deck(session, content: DeckFile, source_kind="file") -> Deck:
    deck = Deck(
        id=uid(),
        title=content.deck.title,
        description=content.deck.description,
        source_kind=source_kind,
        options={"language": content.deck.language, "seq_high_water": len(content.items)},
    )
    session.add(deck)
    session.flush()
    questions = {}
    for q in content.questions:
        question = Question(
            id=uid(),
            deck_id=deck.id,
            ordinal=q.ordinal,
            number_label=q.number_label,
            section=q.section,
            text=q.text,
            answer_text=q.answer_text,
            status="done",
            match_method="combined",
        )
        questions[q.uid] = question.id
        session.add(question)
    session.flush()
    for seq, item in enumerate(content.items, start=1):
        values = item.model_dump(exclude={"uid", "question_uid"})
        values["distractors"] = [d.model_dump() for d in item.distractors]
        session.add(
            QuizItem(
                id=uid(),
                deck_id=deck.id,
                question_id=questions.get(item.question_uid),
                seq=seq,
                **values,
            )
        )
    session.commit()
    return deck


def export_deck(session, deck) -> DeckFile:
    questions = list(
        session.scalars(
            select(Question).where(Question.deck_id == deck.id).order_by(Question.ordinal)
        )
    )
    items = list(
        session.scalars(select(QuizItem).where(QuizItem.deck_id == deck.id).order_by(QuizItem.seq))
    )
    return DeckFile(
        format="study-surfers-deck",
        version=1,
        exported_at=utc_now(),
        app_version=__version__,
        deck={
            "title": deck.title,
            "description": deck.description,
            "language": deck.options.get("language", "ru"),
        },
        questions=[
            {
                "uid": q.id,
                **{
                    k: getattr(q, k)
                    for k in ("ordinal", "number_label", "section", "text", "answer_text")
                },
            }
            for q in questions
        ],
        items=[
            {
                "uid": i.id,
                "question_uid": i.question_id,
                **{
                    k: getattr(i, k)
                    for k in (
                        "prompt",
                        "correct",
                        "distractors",
                        "explanation",
                        "source",
                        "evidence_quote",
                        "enabled",
                    )
                },
            }
            for i in items
        ],
    )


def export_anki(session, deck) -> str:
    """Заметки в виде текста для Anki (Файл → Импорт) и Quizlet: вопрос, ответ, пояснение.

    Заголовки `#` понимает Anki 2.1.55+: разделитель, HTML, колода и названия столбцов.
    Раздел вопроса становится тегом, чтобы колоду можно было разбить уже в Anki.
    """
    rows = session.execute(
        select(QuizItem, Question.section)
        .outerjoin(Question, Question.id == QuizItem.question_id)
        .where(QuizItem.deck_id == deck.id, QuizItem.enabled)
        .order_by(QuizItem.seq)
    ).all()

    def cell(text: str | None) -> str:
        value = html.escape(text or "", quote=False).replace("\t", " ")
        return "<br>".join(line.strip() for line in value.splitlines())

    title = " ".join(deck.title.split())
    lines = [
        "#separator:tab",
        "#html:true",
        f"#deck:{title}",
        "#columns:Вопрос\tОтвет\tПояснение\tТеги",
        "#tags column:4",
    ]
    for item, section in rows:
        tag = "_".join((section or "").split())
        lines.append(
            "\t".join((cell(item.prompt), cell(item.correct), cell(item.explanation), tag))
        )
    return "\n".join(lines) + "\n"


def seed_demo(session):
    if session.scalar(select(func.count()).select_from(Deck)) == 0:
        import_deck(
            session, parse_deck_file((ROOT / "fixtures/demo-deck.ssdeck.json").read_bytes()), "demo"
        )
