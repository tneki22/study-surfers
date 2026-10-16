from typing import Literal

from pydantic import BaseModel, Field


class FieldMapping(BaseModel):
    """Номера полей заметки. У пропусков (cloze) answer не нужен: ответ — скрытый текст."""

    question: int = Field(ge=0)
    answer: int | None = Field(default=None, ge=0)
    extra: int | None = Field(default=None, ge=0)


class FlashcardOptions(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    mode: Literal["auto", "local", "ai"] = Field(
        default="auto",
        description="auto — подходящие сразу, остальные через ИИ; local — без ИИ; ai — все через ИИ",
    )
    mappings: dict[str, FieldMapping] = Field(
        default_factory=dict, description="Поля по id типа заметок; без записи — подбор по именам"
    )
    excluded_note_types: list[str] = Field(default_factory=list)
    decks: list[str] | None = Field(default=None, description="Только эти колоды Anki; null — все")
    reverse: bool = Field(default=False, description="Ещё и обратные карточки: ответ → вопрос")
    prompt_style: Literal["auto", "meaning", "translate"] = Field(
        default="auto",
        description="Короткая лицевая сторона: auto — «Что означает…?» только для слов короче 8 "
        "знаков, meaning и translate — шаблон для всех карточек",
    )


class NoteTypeRead(BaseModel):
    id: str
    name: str
    fields: list[str]
    count: int
    cloze: bool
    mapping: FieldMapping
    examples: list[list[str]] = Field(description="Значения полей первых заметок для подсказки")


class DeckCountRead(BaseModel):
    name: str
    count: int


class ReasonRead(BaseModel):
    plan: Literal["ai", "skip"]
    reason: str
    count: int


class PlannedCardRead(BaseModel):
    plan: Literal["ready", "ai", "skip"]
    front: str
    back: str
    prompt: str | None = None
    correct: str | None = None
    distractors: list[str] = Field(default_factory=list)
    explanation: str = ""
    reason: str | None = None


class PlanCounts(BaseModel):
    total: int
    ready: int
    ai: int
    skipped: int


class FlashcardPreview(BaseModel):
    filename: str
    format: Literal["anki_package", "table"]
    title: str
    note_types: list[NoteTypeRead]
    decks: list[DeckCountRead]
    counts: PlanCounts
    reasons: list[ReasonRead]
    samples: list[PlannedCardRead]
    ai_ready: bool


class FlashcardImportRead(BaseModel):
    deck_id: str
    job_id: str | None
    counts: PlanCounts
