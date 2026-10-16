from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.ai.errors import AiGatewayError as ProjectDomainError

# Единственное определение модальностей шлюза: по нему `resolve_model` ищет
# модель по умолчанию (`AiSettings.default_<модальность>_model_id`), поэтому
# новое значение здесь требует и столбца в настройках.
AiModality = Literal["text"]
CachePolicy = Literal["none", "exact", "content_hash"]
# «off» — явное «думать не надо»: у части моделей рассуждение включено по
# умолчанию, и отличить его от «параметр не задан» можно только отдельным
# значением. Разворачивает его транспорт, по-своему для каждого профиля.
ReasoningEffort = Literal["off", "low", "medium", "high"]


class TextRoleParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    max_output_tokens: int = Field(ge=64)
    temperature: float | None = Field(default=None, ge=0, le=2)
    reasoning_effort: ReasoningEffort | None = None


class ModelTestParameters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    # Рассуждающая модель тратит бюджет на размышление раньше, чем напишет первое
    # слово ответа. Тесный лимит здесь давал пустой ответ у любой такой модели.
    max_output_tokens: int = Field(ge=64, le=8_000)
    reasoning_effort: ReasoningEffort | None = None


@dataclass(frozen=True)
class AiRoleSpec:
    key: str
    title: str
    description: str
    modality: AiModality
    required_capabilities: frozenset[str] = field(default_factory=frozenset)
    cache_policy: CachePolicy = "none"
    prompt_version: str = "1"
    default_parameters: dict[str, object] = field(default_factory=dict)
    allow_request_model_override: bool = False
    parameter_model: type[BaseModel] = TextRoleParameters
    visible: bool = True


ROLE_SPECS = {
    spec.key: spec
    for spec in (
        AiRoleSpec(
            "extract",
            "Структура документов",
            "Находит вопросы и сопоставляет ответы.",
            "text",
            default_parameters={
                "max_output_tokens": 8000,
                "temperature": 0,
                "reasoning_effort": "low",
            },
        ),
        AiRoleSpec(
            "generate",
            "Генерация карточек",
            "Готовит игровые вопросы и варианты ответа.",
            "text",
            prompt_version="quiz-gen-v2",
            default_parameters={
                "max_output_tokens": 6000,
                "temperature": 0.4,
                "reasoning_effort": "off",
            },
        ),
        AiRoleSpec(
            "settings_model_test",
            "Проверка модели",
            "Проверяет ответ выбранной модели.",
            "text",
            default_parameters={"max_output_tokens": 1500, "reasoning_effort": "off"},
            allow_request_model_override=True,
            parameter_model=ModelTestParameters,
            visible=False,
        ),
    )
}


def get_role_spec(role: str) -> AiRoleSpec:
    try:
        return ROLE_SPECS[role]
    except KeyError as error:
        raise ProjectDomainError(
            "Неизвестная роль внешней модели",
            status=404,
            code="ai_role_not_found",
            context={"role": role},
        ) from error


def validate_role_parameters(role: str, values: dict[str, object]) -> dict[str, object]:
    spec = get_role_spec(role)
    merged = spec.default_parameters | values
    try:
        return spec.parameter_model.model_validate(merged).model_dump(exclude_none=True)
    except ValidationError as error:
        raise ProjectDomainError(
            "Параметры роли не прошли проверку",
            status=422,
            code="ai_role_parameters_invalid",
            context={"role": role, "errors": error.errors(include_input=False)},
        ) from error
