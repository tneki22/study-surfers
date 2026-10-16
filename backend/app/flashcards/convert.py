"""Правила импорта флеш-карточек: «вопрос → ответ» становится карточкой забега.

У забега над треками стоят верный ответ и 5–7 неверных. В Anki неверных вариантов нет, поэтому:
- без ИИ неверные варианты — ответы других карточек той же колоды: той же письменности,
  похожей длины, из того же раздела. Так работают короткие ответы: слова, даты, термины;
- длинный ответ, длинный вопрос или колода без похожих ответов уходят модели: она сжимает
  карточку до вопроса с коротким ответом и придумывает варианты (как с карточками Tentex);
- картинки и звук игра не показывает: карточка только из медиа пропускается.
"""

import math
import random
import re
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from statistics import median

from app.core.text import norm_option, visible_len
from app.flashcards.reader import CLOZE, FlashcardSource, NoteType, clean_field, has_media
from app.flashcards.schemas import FieldMapping, FlashcardOptions
from app.pipeline.validate import balanced_formula, same_option, validate_item

AI_LIMIT = 400
PROMPT_LIMIT, ANSWER_LIMIT, EXPLANATION_LIMIT = 160, 70, 300

QUESTION_FIELD = re.compile(
    r"front|question|term|word|text|кратк|вопрос|лицев|термин|слово|текст|понятие", re.I
)
ANSWER_FIELD = re.compile(
    r"back|answer|definition|meaning|translation|ответ|оборот|определени|значени|перевод", re.I
)
EXTRA_FIELD = re.compile(
    r"extra|example|note|comment|context|hint|пример|пояснени|примечани|коммент|подсказ|доп", re.I
)

REASON_EMPTY = "Пустая сторона карточки"
REASON_MEDIA = "Только картинка или звук: в забеге их не показать"
REASON_LONG_ANSWER = "Ответ длиннее 70 знаков: над треком не поместится"
REASON_LONG_PROMPT = "Вопрос длиннее 160 знаков"
REASON_POOL = "Мало похожих ответов для неверных вариантов"
REASON_INSIDE = "Ответ виден в самом вопросе"
REASON_INVALID = "Не прошла проверку карточки"
REASON_NO_AI = "Нужна доработка ИИ, а модель не настроена"
REASON_AI_LIMIT = f"Сверх лимита: ИИ дорабатывает до {AI_LIMIT} карточек за импорт"
REASON_LOCAL_ONLY = "Не подходит без ИИ"


@dataclass
class Card:
    key: str
    front: str
    back: str
    extra: str = ""
    section: str | None = None
    tags: list[str] = field(default_factory=list)
    plan: str = "ready"
    reason: str | None = None
    item: dict | None = None
    # Для модели: у пропусков сюда идёт ответ и полный текст, у обычной карточки — оборот.
    ai_back: str = ""
    # forward, reverse или cloze: у каждого вида свой пул неверных вариантов.
    kind: str = "forward"


def auto_mapping(note_type: NoteType) -> FieldMapping:
    """Поля по именам: Front/Back, «Вопрос»/«Ответ», Text/Extra у пропусков; иначе 1-е и 2-е."""
    names = note_type.fields

    def find(pattern, skip=()):
        return next((i for i, n in enumerate(names) if i not in skip and pattern.search(n)), None)

    if note_type.cloze:
        question = find(re.compile(r"^(text|текст)$", re.I))
        question = 0 if question is None else question
        extra = find(EXTRA_FIELD, (question,))
        if extra is None and len(names) > 1:
            extra = 1 if question != 1 else None
        return FieldMapping(question=question, answer=None, extra=extra)
    question = find(QUESTION_FIELD)
    question = 0 if question is None else question
    answer = find(ANSWER_FIELD, (question,))
    if answer is None:
        answer = next((i for i in range(len(names)) if i != question), None)
    extra = find(EXTRA_FIELD, (question, answer))
    return FieldMapping(question=question, answer=answer, extra=extra)


def mapping_for(note_type: NoteType, options: FlashcardOptions) -> FieldMapping:
    mapping = options.mappings.get(note_type.id) or auto_mapping(note_type)
    limit = len(note_type.fields)
    return FieldMapping(
        question=min(mapping.question, max(0, limit - 1)),
        answer=mapping.answer if mapping.answer is not None and mapping.answer < limit else None,
        extra=mapping.extra if mapping.extra is not None and mapping.extra < limit else None,
    )


def one_line(text: str, joiner: str = " ") -> str:
    return joiner.join(part.strip() for part in text.split("\n") if part.strip())


def shorten(text: str, limit: int) -> str:
    if visible_len(text) <= limit:
        return text
    cut = text[: limit - 1].rsplit(" ", 1)[0].rstrip(" ,;:—-")
    return cut + "…"


def _field(values: list[str], index: int | None) -> str:
    return values[index] if index is not None and index < len(values) else ""


def build_cards(source: FlashcardSource, options: FlashcardOptions) -> list[Card]:
    sections = len(source.decks) > 1
    cards: list[Card] = []
    for note in source.notes:
        note_type = source.note_types[note.note_type]
        if note_type.id in options.excluded_note_types:
            continue
        if options.decks is not None and (note.deck or "") not in options.decks:
            continue
        mapping = mapping_for(note_type, options)
        section = note.deck.split("::")[-1] if sections and note.deck else None
        extra = one_line(clean_field(_field(note.fields, mapping.extra)))
        raw_question = _field(note.fields, mapping.question)
        common = {"section": section, "tags": note.tags, "extra": extra}
        if CLOZE.search(raw_question):
            cards.extend(_cloze_cards(note.id, raw_question, common))
            continue
        raw_answer = _field(note.fields, mapping.answer)
        front, back = clean_field(raw_question), clean_field(raw_answer)
        if not front or not back:
            media = has_media(raw_question) or has_media(raw_answer)
            cards.append(
                Card(
                    note.id,
                    front or "[картинка]",
                    back or "[картинка]",
                    plan="skip",
                    reason=REASON_MEDIA if media else REASON_EMPTY,
                    **common,
                )
            )
            continue
        cards.append(Card(note.id, front, back, ai_back=back, **common))
        if options.reverse:
            cards.append(Card(f"{note.id}-r", back, front, ai_back=front, kind="reverse", **common))
    return cards


def _cloze_cards(note_id: str, raw: str, common: dict) -> list[Card]:
    """{{c1::Париж}} — столица Франции → «___ — столица Франции», ответ «Париж».

    Каждый номер пропуска — своя карточка, остальные пропуски раскрыты, подсказка — в скобках.
    """
    full = clean_field(CLOZE.sub(lambda m: m[2], raw))
    output = []
    for number in sorted({int(m[1]) for m in CLOZE.finditer(raw)}):
        answers: list[str] = []

        def hide(match, number=number, answers=answers):
            if int(match[1]) != number:
                return match[2]
            answers.append(one_line(clean_field(match[2])))
            return "___" + (f" ({match[3]})" if match[3] else "")

        front = clean_field(CLOZE.sub(hide, raw))
        back = " / ".join(dict.fromkeys(a for a in answers if a))
        if not back:
            continue
        output.append(
            Card(
                f"{note_id}-c{number}",
                front,
                back,
                ai_back=f"Скрыто: {back}\n\nПолный текст: {full}",
                kind="cloze",
                **common,
            )
        )
    return output


def make_prompt(front: str, style: str) -> str:
    text = one_line(front)
    wrap = style != "auto" or (visible_len(text) < 8 and not text.endswith("?"))
    if not wrap:
        return text
    template = "Как переводится «{}»?" if style == "translate" else "Что означает «{}»?"
    return template.format(text.rstrip(".:"))


SCRIPTS = (("cyr", re.compile(r"[а-яё]", re.I)), ("lat", re.compile(r"[a-z]", re.I)))


def script_of(text: str) -> str:
    """Письменность ответа: латиница среди кириллицы выдала бы верный вариант сразу."""
    letters = {name: len(pattern.findall(text)) for name, pattern in SCRIPTS}
    if not any(letters.values()):
        return "num" if re.search(r"\d", text) else "other"
    return max(letters, key=letters.get)


@dataclass
class PoolEntry:
    text: str
    key: str
    norm: str
    length: int
    words: int
    section: str | None
    tags: frozenset


class AnswerPool:
    """Ответы карточек, разложенные по письменности и отсортированные по длине."""

    def __init__(self, cards: list[Card]):
        self.groups: dict[str, list[PoolEntry]] = {}
        seen: set[tuple[str, str]] = set()
        for card in cards:
            text = one_line(card.back, "; ")
            length = visible_len(text)
            norm = norm_option(text)
            if not norm or length > ANSWER_LIMIT or (script_of(text), norm) in seen:
                continue
            seen.add((script_of(text), norm))
            self.groups.setdefault(script_of(text), []).append(
                PoolEntry(
                    text,
                    card.key,
                    norm,
                    length,
                    len(text.split()),
                    card.section,
                    frozenset(card.tags),
                )
            )
        for entries in self.groups.values():
            entries.sort(key=lambda e: e.length)
        self.lengths = {k: [e.length for e in v] for k, v in self.groups.items()}

    def candidates(self, card: Card, correct: str, prompt: str) -> list[PoolEntry]:
        script = script_of(correct)
        entries = self.groups.get(script, [])
        length = visible_len(correct)
        low = bisect_left(self.lengths.get(script, []), math.ceil(0.5 * length))
        high = bisect_right(self.lengths.get(script, []), 2 * length)
        window = entries[low:high]
        if len(window) > 600:
            # Огромная колода: берём ближайшие по длине, этого хватает с запасом.
            middle = bisect_left([e.length for e in window], length)
            window = window[max(0, middle - 300) : middle + 300]
        own = norm_option(correct)
        prompt_norm = norm_option(prompt)
        return [
            entry
            for entry in window
            if entry.norm != own
            and not (len(entry.norm) >= 3 and entry.norm in prompt_norm)
            and not same_option(entry.text, correct)
        ]


def _closeness(entry: PoolEntry, card: Card, correct: str) -> float:
    length, words = visible_len(correct), len(correct.split())
    score = -abs(entry.length - length) / max(length, 1) * 2 - abs(entry.words - words) * 0.7
    if card.section and entry.section == card.section:
        score += 1.5
    score += min(2, len(entry.tags & set(card.tags))) * 0.5
    if bool(re.search(r"\d", entry.text)) == bool(re.search(r"\d", correct)):
        score += 0.8
    return score


def local_item(card: Card, pool: AnswerPool, style: str) -> tuple[dict | None, str | None]:
    prompt = make_prompt(card.front, style)
    correct = one_line(card.back, "; ")
    if visible_len(correct) > ANSWER_LIMIT or len(correct) > 120:
        return None, REASON_LONG_ANSWER
    if visible_len(prompt) > PROMPT_LIMIT or len(prompt) > 240:
        return None, REASON_LONG_PROMPT
    if len(norm_option(correct)) >= 4 and norm_option(correct) in norm_option(prompt):
        return None, REASON_INSIDE
    rng = random.Random(card.key)
    ranked = sorted(
        pool.candidates(card, correct, prompt),
        key=lambda e: (-_closeness(e, card, correct), rng.random()),
    )
    chosen: list[PoolEntry] = []
    for entry in ranked:
        if not any(same_option(entry.text, c.text) for c in chosen):
            chosen.append(entry)
        if len(chosen) >= 4:
            break
    rest = [
        e
        for e in ranked[len(chosen) :]
        if e not in chosen and not any(same_option(e.text, c.text) for c in chosen)
    ]
    rng.shuffle(rest)
    far: list[PoolEntry] = []
    for entry in rest:
        if not any(same_option(entry.text, c.text) for c in [*chosen, *far]):
            far.append(entry)
        if len(far) >= 3:
            break
    # Похожие (near) — ближайшие по длине и разделу, явно неверные (far) — случайные из колоды.
    near, far = _balance(chosen, far)
    if len(near) < 3 or len(far) < 2:
        return None, REASON_POOL
    extra = shorten(card.extra, EXPLANATION_LIMIT) if card.extra else ""
    if extra and not balanced_formula(extra):
        extra = ""
    item = {
        "prompt": prompt,
        "correct": correct,
        "distractors": [
            {"text": e.text, "kind": kind, "why_wrong": ""}
            for kind, group in (("near", near), ("far", far))
            for e in group
        ],
        "explanation": extra,
        "source": "flashcard",
        "evidence_quote": None,
        "enabled": True,
    }
    lengths = [e.length for e in [*near, *far]]
    if visible_len(correct) / max(1, median(lengths)) > 1.6:
        return None, REASON_POOL
    _, issues = validate_item(item)
    if issues:
        if any("длиной" in i or "Недостаточно" in i for i in issues):
            return None, REASON_POOL
        if any("содержит верный" in i for i in issues):
            return None, REASON_INSIDE
        return None, REASON_INVALID
    return item, None


def _balance(near, far):
    """Нужно 3+ похожих и 2+ явно неверных: недостающие far берём из хвоста похожих."""
    near, far = list(near), list(far)
    while len(far) < 2 and len(near) > 3:
        far.append(near.pop())
    return near, far[:3]


def plan_cards(source: FlashcardSource, options: FlashcardOptions, *, ai_ready: bool) -> list[Card]:
    cards = build_cards(source, options)
    # Обратные карточки берут неверные варианты из лицевых сторон, прямые — из оборотов,
    # пропуски — из других пропусков: слово из словаря не подходит вариантом к «___ — столица».
    usable = [c for c in cards if c.plan != "skip"]
    pools: dict[str, AnswerPool] = {}
    for group in {c.kind for c in usable}:
        pools[group] = AnswerPool([c for c in usable if c.kind == group])
    ai_count = 0
    for card in cards:
        if card.plan == "skip":
            continue
        if options.mode != "ai":
            pool = pools[card.kind]
            card.item, reason = local_item(card, pool, options.prompt_style)
            if card.item:
                card.plan = "ready"
                continue
            card.reason = reason
            if options.mode == "local":
                card.plan = "skip"
                continue
        if not ai_ready:
            card.plan, card.reason = "skip", REASON_NO_AI
        elif ai_count >= AI_LIMIT:
            card.plan, card.reason = "skip", REASON_AI_LIMIT
        else:
            card.plan = "ai"
            card.reason = card.reason or "Вопрос и варианты придумает модель"
            ai_count += 1
    return cards
