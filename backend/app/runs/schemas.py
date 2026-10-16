from datetime import datetime
from math import isfinite
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, Field, field_validator

from app.decks.schemas import ApiModel


class RunSettings(BaseModel):
    lanes: Literal[3, 4]
    difficulty: Literal["easy", "medium", "hard"]
    filter: Literal["all", "weak", "last_mistakes"] = "all"
    pace: str | float
    lives: int | None = Field(default=None, ge=0)
    # Старые забеги без этих полей шли днём с обычными препятствиями.
    world: Literal["classic", "night-maglev"] = "classic"
    obstacles: Literal["off", "normal", "more"] = "normal"

    @field_validator("pace")
    @classmethod
    def valid_pace(cls, value):
        if isinstance(value, str) and (not value.strip() or len(value) > 80):
            raise ValueError("Укажите темп забега")
        if isinstance(value, float) and (value <= 0 or not isfinite(value)):
            raise ValueError("Темп забега должен быть положительным")
        return value


class AnswerCreate(BaseModel):
    item_id: str
    ordinal: int = Field(ge=0)
    chosen_text: str
    chosen_kind: Literal["correct", "far", "near", "timeout"]
    correct: bool
    reaction_ms: int = Field(ge=0)


class RunCreate(BaseModel):
    id: UUID
    deck_id: str
    settings: RunSettings
    started_at: datetime
    finished_at: datetime
    score: int = Field(ge=0)
    distance: float = Field(ge=0)
    max_streak: int = Field(ge=0)
    answers: list[AnswerCreate] = Field(max_length=10000)

    @field_validator("started_at", "finished_at")
    @classmethod
    def timezone_required(cls, value):
        if value.tzinfo is None:
            raise ValueError("Укажите часовой пояс времени забега")
        return value


class RunSummary(ApiModel):
    id: str
    deck_id: str
    settings: RunSettings
    score: int
    distance: float
    max_streak: int
    correct_count: int
    wrong_count: int
    duration_ms: int
    started_at: datetime
    finished_at: datetime


class MistakeRead(BaseModel):
    item_id: str | None
    prompt: str
    correct: str
    chosen_text: str
    chosen_kind: Literal["correct", "far", "near", "timeout"]
    why_wrong: str | None
    explanation: str
    source: Literal["user_docs", "ai_knowledge", "tentex_card", "flashcard"]


class RunDetail(RunSummary):
    mistakes: list[MistakeRead]


class SectionStats(BaseModel):
    section: str | None
    accuracy: float
    count: int


class DeckStats(BaseModel):
    item_count: int
    seen_count: int
    mastered_count: int
    weak_count: int
    best_score: int | None
    runs_count: int
    last_run: RunSummary | None
    by_section: list[SectionStats]
