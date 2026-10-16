from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

from app.decks.schemas import ApiModel
from app.pipeline.prompts import LEARNER_PROMPT_MAX


class ImportOptions(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    auto_title: bool = Field(
        default=False,
        description="Без title: после разбора вопросов модель придумает название новой колоды",
    )
    items_per_question: Literal["auto", 1, 3, 5] = "auto"
    learner_prompt: str | None = Field(
        default=None,
        max_length=LEARNER_PROMPT_MAX,
        description="Пожелания к карточкам: уровень, что спрашивать, как объяснять. "
        "Пусто — пресет «Готовлюсь к экзамену». Сохраняется в колоде для перегенерации",
    )
    deck_id: str | None = None
    confirm_cost: bool = False
    roles: dict[str, Literal["questions", "answers", "combined", "notes"]] = Field(
        default_factory=dict
    )


class LearnerPresetRead(BaseModel):
    id: str
    label: str
    text: str


class LearnerPresetsRead(BaseModel):
    default_id: str
    max_length: int
    presets: list[LearnerPresetRead]


class WarningRead(BaseModel):
    code: str
    message: str
    context: dict = Field(default_factory=dict)


class ImportRead(BaseModel):
    deck_id: str
    job_id: str


class StructuredQuestionRead(BaseModel):
    id: str
    ordinal: int
    number_label: str
    text: str
    section: str | None
    answer_text: str | None
    answer_doc_id: str | None
    match_method: str
    synthetic: bool


class DocumentRead(BaseModel):
    id: str
    filename: str
    kind: str
    role: str
    char_count: int
    warnings: list[WarningRead]


class DryRunRead(BaseModel):
    questions: list[StructuredQuestionRead]
    documents: list[DocumentRead]
    warnings: list[WarningRead]


class UsageRead(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    cost_usd: float | None = None


class EstimateRead(UsageRead):
    requires_confirm: bool
    reasons: list[str]


class JobError(BaseModel):
    code: str
    detail: str


class JobSource(BaseModel):
    """Файл задачи и его роль; role пуст, пока «Авто» её не определил."""

    filename: str
    role: Literal["questions", "answers", "combined", "notes"] | None


class JobRead(ApiModel):
    id: str
    deck_id: str
    kind: Literal["quick_import", "tentex_import", "flashcard_import", "regen_question"]
    state: Literal[
        "queued",
        "extracting",
        "structuring",
        "awaiting_confirm",
        "awaiting_executor",
        "generating",
        "done",
        "failed",
        "cancelled",
        "interrupted",
    ]
    stage_label: str
    done: int
    total: int
    ready_items: int
    failed_questions: int
    can_play: bool
    warnings: list[WarningRead]
    error: JobError | None
    estimate: EstimateRead | None
    usage: UsageRead
    sources: list[JobSource] = []
    created_at: datetime
    finished_at: datetime | None


class RegenerateQuestion(BaseModel):
    items_per_question: Literal["auto", 1, 3, 5] | None = None


class RegenerateItem(BaseModel):
    mode: Literal["distractors", "full"]


class JobStarted(BaseModel):
    job_id: str
