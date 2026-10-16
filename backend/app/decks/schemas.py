from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class ApiModel(BaseModel):
    @field_validator("*", mode="after")
    @classmethod
    def utc_fields(cls, value):
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value


class DeckCreate(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=10000)


class DeckPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=10000)


class DeckSummary(ApiModel):
    id: str
    title: str
    status: Literal["generating", "ready", "empty", "failed"]
    source_kind: Literal["upload", "tentex", "file", "demo", "flashcards"]
    item_count: int
    enabled_item_count: int
    question_count: int
    active_job_id: str | None
    runs_count: int
    best_score: int | None
    last_played_at: datetime | None
    weak_count: int
    created_at: datetime
    updated_at: datetime


class SourceRead(BaseModel):
    id: str
    filename: str
    kind: Literal["pdf", "docx", "txt", "md", "typ", "tex", "paste"]
    role: Literal["questions", "answers", "combined", "notes"]
    char_count: int
    warnings: list[dict]


class QuestionCounts(BaseModel):
    total: int
    done: int
    failed: int
    pending: int


class SetupBest(BaseModel):
    """Рекорд колоды для одного мира и режима препятствий: от них зависят монеты и штрафы."""

    world: Literal["classic", "night-maglev"]
    obstacles: Literal["off", "normal", "more"]
    score: int


class DeckDetail(DeckSummary):
    description: str
    options: dict
    questions_summary: QuestionCounts
    sources: list[SourceRead]
    best_by_setup: list[SetupBest]


class Distractor(BaseModel):
    text: str
    kind: Literal["far", "near"]
    why_wrong: str


class StatsRead(ApiModel):
    seen: int
    correct: int
    streak: int
    last_wrong_at: datetime | None


class QuizItemRead(ApiModel):
    id: str
    deck_id: str
    question_id: str | None
    question_ordinal: int | None = None
    seq: int
    prompt: str
    correct: str
    distractors: list[Distractor]
    explanation: str
    source: Literal["user_docs", "ai_knowledge", "tentex_card", "flashcard"]
    evidence_quote: str | None
    section: str | None
    enabled: bool
    edited: bool
    stats: StatsRead | None
    created_at: datetime
    updated_at: datetime


class ItemPage(BaseModel):
    items: list[QuizItemRead]
    next_since: int
    total_ready: int
    job_active: bool


class ItemPatch(BaseModel):
    prompt: str | None = None
    correct: str | None = None
    distractors: list[Distractor] | None = None
    explanation: str | None = None
    enabled: bool | None = None


class QuestionRead(BaseModel):
    id: str
    ordinal: int
    number_label: str
    section: str | None
    text: str
    has_answer: bool
    match_method: str
    status: Literal["pending", "generating", "done", "failed"]
    error: str | None
    item_count: int


class FileHeader(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    description: str = ""
    language: str = "ru"


class FileQuestion(BaseModel):
    uid: str
    ordinal: int = Field(ge=1)
    number_label: str
    section: str | None = None
    text: str
    answer_text: str | None = None


class FileItem(BaseModel):
    uid: str
    question_uid: str | None = None
    prompt: str
    correct: str
    distractors: list[Distractor]
    explanation: str
    source: Literal["user_docs", "ai_knowledge", "tentex_card", "flashcard"]
    evidence_quote: str | None = None
    enabled: bool = True


class DeckFile(ApiModel):
    model_config = ConfigDict(extra="forbid")
    format: Literal["study-surfers-deck"]
    version: Literal[1]
    exported_at: datetime
    app_version: str
    deck: FileHeader
    questions: list[FileQuestion]
    items: list[FileItem]
