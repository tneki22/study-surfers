from __future__ import annotations

import json
from collections import deque
from collections.abc import Sequence
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AsyncOpenAI,
    AuthenticationError,
    RateLimitError,
)

from app.config import get_settings

TRANSIENT_CLIENT_STATUSES = frozenset({408, 409})


@dataclass(frozen=True)
class ProviderModel:
    model_id: str
    display_name: str
    context_length: int | None = None
    max_completion_tokens: int | None = None
    supported_parameters: list[str] = field(default_factory=list)
    input_modalities: list[str] = field(default_factory=list)
    output_modalities: list[str] = field(default_factory=list)
    reasoning: dict[str, Any] = field(default_factory=dict)
    default_parameters: dict[str, Any] = field(default_factory=dict)
    prompt_price_usd: Decimal | None = None
    completion_price_usd: Decimal | None = None
    knowledge_cutoff: str | None = None
    expiration_date: str | None = None


@dataclass(frozen=True)
class ProviderUsage:
    input_tokens: int = 0
    output_tokens: int = 0
    reasoning_tokens: int = 0
    cached_tokens: int = 0
    cost_usd: Decimal | None = None


@dataclass(frozen=True)
class ProviderCompletion:
    content: str
    actual_model_id: str
    usage: ProviderUsage
    request_id: str | None = None


class ProviderError(Exception):
    def __init__(self, code: str, detail: str, *, usage: ProviderUsage | None = None) -> None:
        super().__init__(detail)
        self.code = code
        self.detail = detail
        self.usage = usage


def _decimal(value: object) -> Decimal | None:
    if value is None:
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def _usage(value: object) -> ProviderUsage:
    data = value.model_dump() if hasattr(value, "model_dump") else (value or {})
    details = data.get("completion_tokens_details") or {}
    prompt_details = data.get("prompt_tokens_details") or {}
    return ProviderUsage(
        input_tokens=data.get("prompt_tokens") or 0,
        output_tokens=data.get("completion_tokens") or 0,
        reasoning_tokens=details.get("reasoning_tokens") or 0,
        cached_tokens=prompt_details.get("cached_tokens") or 0,
        cost_usd=_decimal(data.get("cost")),
    )


def _empty_response_error(choice: object, usage: object) -> ProviderError:
    """Пустой ответ бывает по разным причинам, и лечатся они по-разному."""
    finish_reason = getattr(choice, "finish_reason", None)
    message = getattr(choice, "message", None)
    reasoning = getattr(message, "reasoning", None) if message is not None else None
    reasoning_tokens = _usage(usage).reasoning_tokens
    if finish_reason == "length" or reasoning or reasoning_tokens:
        return ProviderError(
            "ai_empty_response",
            "Модель потратила весь лимит токенов на рассуждение и не успела ответить. "
            "Увеличьте максимум токенов ответа или выберите модель без рассуждения",
            usage=_usage(usage),
        )
    if finish_reason == "content_filter":
        return ProviderError(
            "ai_empty_response",
            "Провайдер заблокировал ответ фильтром содержимого",
            usage=_usage(usage),
        )
    return ProviderError("ai_empty_response", "Модель вернула пустой ответ", usage=_usage(usage))


def _provider_message(error: APIStatusError) -> str:
    """Объяснение провайдера: без него «Провайдер отклонил запрос» ничем не помогает."""
    body: object = getattr(error, "body", None)
    for _ in range(2):
        if isinstance(body, dict):
            message = body.get("message")
            if (
                isinstance(message, str)
                and message.strip()
                and message.strip() != "Provider returned error"
            ):
                return message.strip()
            metadata = body.get("metadata")
            raw = metadata.get("raw") if isinstance(metadata, dict) else None
            if isinstance(raw, str):
                try:
                    nested = json.loads(raw)
                except json.JSONDecodeError:
                    nested = None
                if isinstance(nested, dict):
                    nested_error = nested.get("error")
                    nested_message = (
                        nested_error.get("message") if isinstance(nested_error, dict) else None
                    )
                    if isinstance(nested_message, str) and nested_message.strip():
                        return nested_message.strip()
            body = body.get("error")
            continue
        break
    return ""


def _with_reason(base: str, error: APIStatusError) -> str:
    message = _provider_message(error)
    return f"{base}: {message}" if message else base


def normalize_provider_error(error: Exception) -> ProviderError:
    if isinstance(error, AuthenticationError):
        return ProviderError(
            "ai_invalid_credentials", _with_reason("Провайдер отклонил ключ", error)
        )
    if isinstance(error, RateLimitError):
        return ProviderError(
            "ai_rate_limited", _with_reason("Провайдер временно ограничил запросы", error)
        )
    if isinstance(error, APITimeoutError):
        return ProviderError("ai_timeout", "Провайдер не ответил вовремя")
    if isinstance(error, APIConnectionError):
        return ProviderError("ai_provider_unavailable", "Не удалось подключиться к провайдеру")
    if isinstance(error, APIStatusError):
        if error.status_code >= 500:
            return ProviderError(
                "ai_provider_unavailable", _with_reason("Провайдер временно недоступен", error)
            )
        if error.status_code not in TRANSIENT_CLIENT_STATUSES:
            # Отклонённый запрос провайдер не исполнял и не тарифицировал, а
            # повтор того же запроса получит тот же отказ: ноль расхода и без повторов.
            return ProviderError(
                "ai_request_rejected",
                _with_reason("Провайдер отклонил запрос", error),
                usage=ProviderUsage(cost_usd=Decimal(0)),
            )
        return ProviderError(
            "ai_provider_unavailable", _with_reason("Провайдер отклонил запрос", error)
        )
    if isinstance(error, ProviderError):
        return error
    return ProviderError("ai_provider_unavailable", "Вызов внешней модели завершился ошибкой")


class OpenAITransport:
    def __init__(
        self, base_url: str, api_key: str, catalog_profile: str = "openai_compatible"
    ) -> None:
        self.catalog_profile = catalog_profile
        self.client = AsyncOpenAI(
            base_url=base_url,
            api_key=api_key or "not-needed",
            timeout=get_settings().ai_timeout_seconds,
            max_retries=0,
        )

    async def list_models(self) -> list[ProviderModel]:
        try:
            result = await self.client.models.list()
        except Exception as error:
            raise normalize_provider_error(error) from error
        models = []
        for item in result.data:
            data = item.model_dump()
            pricing = data.get("pricing") or {}
            architecture = data.get("architecture") or {}
            input_modalities = architecture.get("input_modalities") or ["text"]
            output_modalities = architecture.get("output_modalities") or ["text"]
            models.append(
                ProviderModel(
                    model_id=item.id,
                    display_name=data.get("name") or item.id,
                    context_length=data.get("context_length"),
                    max_completion_tokens=(data.get("top_provider") or {}).get(
                        "max_completion_tokens"
                    ),
                    supported_parameters=data.get("supported_parameters") or [],
                    input_modalities=input_modalities,
                    output_modalities=output_modalities,
                    reasoning=data.get("reasoning") or {},
                    default_parameters=data.get("default_parameters") or {},
                    prompt_price_usd=_decimal(pricing.get("prompt")),
                    completion_price_usd=_decimal(pricing.get("completion")),
                    knowledge_cutoff=data.get("knowledge_cutoff"),
                    expiration_date=data.get("expiration_date"),
                )
            )
        return models

    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        response_schema: dict[str, Any] | None,
        max_output_tokens: int,
        parameters: dict[str, object],
        mode: str = "json_schema",
    ) -> ProviderCompletion:
        kwargs: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_output_tokens,
        }
        # `usage.include` — расширение OpenRouter, из него приходит стоимость. Groq
        # и прочие OpenAI-совместимые API отвечают на незнакомое поле отказом,
        # а токены у них и так возвращаются в обычном `usage`.
        if self.catalog_profile == "openrouter":
            kwargs["extra_body"] = {"usage": {"include": True}}
        self._apply_parameters(kwargs, parameters)
        if response_schema is not None and mode == "json_schema":
            kwargs["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": "study_surfers_result",
                    "strict": True,
                    "schema": response_schema,
                },
            }
        if response_schema is not None and mode == "json_object":
            kwargs["response_format"] = {"type": "json_object"}
        try:
            result = await self.client.chat.completions.create(**kwargs)
        except Exception as error:
            raise normalize_provider_error(error) from error
        choice = result.choices[0] if result.choices else None
        content = choice.message.content if choice is not None else None
        if not isinstance(content, str) or not content.strip():
            raise _empty_response_error(choice, result.usage)
        return ProviderCompletion(
            content=content,
            actual_model_id=result.model,
            usage=_usage(result.usage),
            request_id=getattr(result, "id", None),
        )

    def _apply_parameters(self, kwargs: dict[str, Any], parameters: dict[str, object]) -> None:
        direct = {
            "temperature",
            "top_p",
            "seed",
            "frequency_penalty",
            "presence_penalty",
            "stop",
        }
        extra = dict(kwargs.get("extra_body") or {})
        for key, value in parameters.items():
            if key == "max_output_tokens":
                continue
            if key == "reasoning_effort":
                self._apply_reasoning(kwargs, extra, value)
            elif key in direct:
                kwargs[key] = value
            else:
                extra[key] = value
        if extra:
            kwargs["extra_body"] = extra

    def _apply_reasoning(
        self, kwargs: dict[str, Any], extra: dict[str, Any], value: object
    ) -> None:
        """Один параметр — два разных поля запроса, по профилю провайдера.

        У OpenRouter это объект `reasoning`, и только он умеет сказать «не
        рассуждай» (`enabled: false`). У OpenAI-совместимых API это плоский
        `reasoning_effort`, выключения в нём нет — там «off» значит просто не
        слать поле и оставить поведение модели по умолчанию.
        """
        if value is None:
            return
        if self.catalog_profile == "openrouter":
            extra["reasoning"] = {"enabled": False} if value == "off" else {"effort": value}
            return
        if value != "off":
            kwargs["reasoning_effort"] = value


class OpenAICompatibleTransport(Protocol):
    async def list_models(self) -> list[ProviderModel]: ...
    async def complete(
        self,
        *,
        model: str,
        messages: list[dict[str, str]],
        response_schema: dict[str, Any] | None,
        max_output_tokens: int,
        parameters: dict[str, object],
        mode: str = "json_schema",
    ) -> ProviderCompletion: ...


class FakeTransport:
    """Транспорт с очередью ответов; сеть в тестах не используется."""

    def __init__(
        self,
        *,
        models: Sequence[ProviderModel] = (),
        completions: Sequence[ProviderCompletion | Exception] = (),
    ) -> None:
        self.models = list(models)
        self.completions = deque(completions)
        self.list_calls = 0
        self.complete_calls = 0
        self.complete_requests: list[dict[str, Any]] = []

    async def list_models(self) -> list[ProviderModel]:
        self.list_calls += 1
        return list(self.models)

    async def complete(self, **kwargs) -> ProviderCompletion:
        self.complete_calls += 1
        self.complete_requests.append(kwargs)
        if not self.completions:
            raise ProviderError(
                "ai_provider_unavailable", "Очередь ответов тестового транспорта пуста"
            )
        result = self.completions.popleft()
        if isinstance(result, Exception):
            raise result
        return result
