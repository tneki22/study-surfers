from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, field_validator

from app.ai.roles import AiModality as Modality

NonBlank = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
CatalogProfile = Literal["openrouter", "openai_compatible"]


class ApiModel(BaseModel):
    model_config = ConfigDict(extra="forbid", from_attributes=True)

    @field_validator("*", mode="after")
    @classmethod
    def utc_fields(cls, value):
        if isinstance(value, datetime) and value.tzinfo is None:
            return value.replace(tzinfo=UTC)
        return value


class AiModelSelection(ApiModel):
    provider_id: str
    model_id: NonBlank


class AiGlobalSettingsWrite(ApiModel):
    external_models_enabled: bool
    daily_limit_usd: Decimal | None = Field(default=None, ge=0)
    operation_limit_usd: Decimal | None = Field(default=None, ge=0)
    confirm_cost_usd: Decimal | None = Field(default=None, ge=0)
    confirm_input_tokens: int = Field(ge=0, le=10_000_000)
    usd_rub_rate: Decimal | None = Field(default=None, gt=0)
    usd_rub_rate_date: date | None = None


class AiProviderWrite(ApiModel):
    label: NonBlank
    catalog_profile: CatalogProfile = "openai_compatible"
    base_url: NonBlank
    api_key: str | None = Field(default=None, max_length=20_000)


class AiDefaultWrite(ApiModel):
    selection: AiModelSelection | None = None


class AiRoleWrite(ApiModel):
    enabled: bool
    provider_override_id: str | None = None
    model_override: str | None = Field(default=None, max_length=500)
    parameters: dict[str, object] = Field(default_factory=dict)


class AiProviderFavoritesWrite(ApiModel):
    provider_ids: list[str] = Field(max_length=100)


class AiModelFavoritesWrite(ApiModel):
    models: list[AiModelSelection] = Field(max_length=100)


class AiManualModelWrite(ApiModel):
    model_id: NonBlank
    display_name: NonBlank
    context_length: int | None = Field(default=None, gt=0)
    max_completion_tokens: int | None = Field(default=None, gt=0)
    supported_parameters: list[str] = Field(default_factory=list)
    input_modalities: list[str] = Field(default_factory=lambda: ["text"])
    output_modalities: list[str] = Field(default_factory=lambda: ["text"])
    reasoning: dict[str, object] = Field(default_factory=dict)
    default_parameters: dict[str, object] = Field(default_factory=dict)
    prompt_price_usd: Decimal | None = Field(default=None, ge=0)
    completion_price_usd: Decimal | None = Field(default=None, ge=0)
    knowledge_cutoff: str | None = None
    expiration_date: str | None = None


class AiCatalogModelWrite(ApiModel):
    model_id: NonBlank
    display_name: NonBlank
    context_length: int | None = Field(default=None, gt=0)
    max_completion_tokens: int | None = Field(default=None, gt=0)
    supported_parameters: list[str] = Field(default_factory=list)
    input_modalities: list[str] = Field(default_factory=list)
    output_modalities: list[str] = Field(default_factory=list)
    reasoning: dict[str, object] = Field(default_factory=dict)
    default_parameters: dict[str, object] = Field(default_factory=dict)
    prompt_price_usd: Decimal | None = Field(default=None, ge=0)
    completion_price_usd: Decimal | None = Field(default=None, ge=0)
    knowledge_cutoff: str | None = None
    expiration_date: str | None = None


class AiCatalogModelRead(AiCatalogModelWrite):
    is_added: bool


class AiProviderRead(ApiModel):
    id: str
    label: str
    catalog_profile: CatalogProfile
    base_url: str
    executor_kind: Literal["api", "codex", "claude"] = "api"
    has_api_key: bool
    is_favorite: bool
    model_count: int
    last_test_status: str | None
    last_tested_at: datetime | None
    last_catalog_refresh_at: datetime | None
    updated_at: datetime


class AiModelRead(ApiModel):
    provider_id: str
    model_id: str
    display_name: str
    context_length: int | None
    max_completion_tokens: int | None
    supported_parameters: list[str]
    input_modalities: list[str]
    output_modalities: list[str]
    reasoning: dict[str, object]
    default_parameters: dict[str, object]
    manual_overrides: dict[str, object]
    prompt_price_usd: Decimal | None
    completion_price_usd: Decimal | None
    knowledge_cutoff: str | None
    expiration_date: str | None
    pricing_snapshot_at: datetime
    catalog_snapshot_at: datetime
    is_manually_added: bool
    favorite_order: int | None
    is_available: bool


class AiRoleRead(ApiModel):
    role: str
    title: str
    description: str
    modality: Modality
    enabled: bool
    provider_override_id: str | None
    model_override: str | None
    resolved_provider_id: str | None
    resolved_model: str | None
    model_source: str | None
    required_capabilities: list[str]
    parameters: dict[str, object]


class AiTodayUsage(ApiModel):
    run_count: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    actual_cost_usd: Decimal = Decimal("0")
    actual_cost_rub: Decimal = Decimal("0")
    cache_hits: int = 0


class AiSettingsRead(ApiModel):
    external_models_enabled: bool
    daily_limit_usd: Decimal | None
    operation_limit_usd: Decimal | None
    confirm_cost_usd: Decimal | None
    confirm_input_tokens: int
    usd_rub_rate: Decimal | None
    usd_rub_rate_date: date | None
    default_text: AiModelSelection | None
    default_speech: None = None
    chat_preset: None = None
    providers: list[AiProviderRead]
    roles: list[AiRoleRead]
    models: list[AiModelRead]
    today_usage: AiTodayUsage


class AiProviderTestRead(ApiModel):
    status: Literal["connected"]
    model_count: int
    tested_at: datetime


class AiModelTestWrite(ApiModel):
    model_id: NonBlank


class AiModelTestRead(ApiModel):
    status: Literal["answered"]
    # «speech» — модель распознавания речи: её проверяют записью тишины, а не вопросом.
    kind: Literal["text"] = "text"
    run_id: str
    duration_ms: int
    answer: str
    actual_model_id: str
    input_tokens: int
    output_tokens: int
