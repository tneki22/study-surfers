from datetime import UTC, datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class TentexStatus(BaseModel):
    root: str
    db_found: bool
    secret_found: bool
    running: bool
    projects_count: int


class TentexProject(BaseModel):
    id: str
    name: str
    status: str
    question_count: int
    answer_count: int
    card_count: int
    updated_at: datetime

    @field_validator("updated_at")
    @classmethod
    def utc_time(cls, value: datetime) -> datetime:
        return value.replace(tzinfo=UTC) if value.tzinfo is None else value.astimezone(UTC)


class TentexProjectImport(BaseModel):
    items_per_question: Literal["auto", 1, 3, 5] = "auto"
    use_answers: bool = True
    use_cards: bool = True
    title: str | None = Field(default=None, min_length=1, max_length=200)


class TentexImportResult(BaseModel):
    deck_id: str
    job_id: str


class TentexProvider(BaseModel):
    tentex_id: str
    label: str
    base_url: str
    catalog_profile: str
    has_api_key: bool
    decryptable: bool
    model_count: int
    already_imported: bool


class TentexProvidersImport(BaseModel):
    provider_ids: list[str] | None = None
    include_models: bool = True
    set_default: bool = True
