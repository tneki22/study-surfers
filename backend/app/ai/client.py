"""Короткие сессии БД, журнал расхода и совместимый структурированный вывод."""

from __future__ import annotations

import asyncio
import json
import re
import time
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Generic, TypeVar

from openai.lib._pydantic import to_strict_json_schema
from pydantic import BaseModel, ValidationError
from sqlalchemy import func, select

from app.ai.catalog import production_transport
from app.ai.errors import AiGatewayError, provider_status
from app.ai.models import AiCall, AiModelCatalogEntry, AiSettings
from app.ai.provider import OpenAICompatibleTransport, ProviderError, ProviderUsage
from app.ai.roles import validate_role_parameters
from app.ai.schemas import AiModelSelection, AiModelTestRead
from app.ai.settings import ResolvedModel, resolve_model
from app.config import get_settings
from app.db import session_factory

T = TypeVar("T", bound=BaseModel)
RETRYABLE_PROVIDER_CODES = {
    "ai_provider_unavailable",
    "ai_empty_response",
    "ai_rate_limited",
    "ai_timeout",
}
SAMPLING_PARAMETERS = {
    "temperature",
    "top_p",
    "seed",
    "frequency_penalty",
    "presence_penalty",
    "stop",
}
UNSUPPORTED_SCHEMA_KEYWORDS = {
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "multipleOf",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
}
SCHEMA_NAME_MAPS = {"properties", "$defs", "definitions"}


def _without_unsupported_keywords(node: Any) -> Any:
    if isinstance(node, list):
        return [_without_unsupported_keywords(item) for item in node]
    if not isinstance(node, dict):
        return node
    result = {}
    for key, value in node.items():
        if key in UNSUPPORTED_SCHEMA_KEYWORDS:
            continue
        if key in SCHEMA_NAME_MAPS and isinstance(value, dict):
            result[key] = {name: _without_unsupported_keywords(sub) for name, sub in value.items()}
        else:
            result[key] = _without_unsupported_keywords(value)
    return result


def clean_json(content: str) -> str:
    content = re.sub(r"<think\b[^>]*>.*?</think>", "", content, flags=re.I | re.S).strip()
    if content.startswith("```"):
        content = re.sub(r"^```(?:json)?\s*", "", content, flags=re.I)
        content = re.sub(r"\s*```$", "", content)
    return content.strip()


def estimate_cost(input_tokens: int, output_tokens: int, resolved: ResolvedModel) -> Decimal | None:
    model = resolved.model
    if model.prompt_price_usd is None or model.completion_price_usd is None:
        return None
    return input_tokens * model.prompt_price_usd + output_tokens * model.completion_price_usd


def _sum_usage(left: ProviderUsage, right: ProviderUsage) -> ProviderUsage:
    return ProviderUsage(
        input_tokens=left.input_tokens + right.input_tokens,
        output_tokens=left.output_tokens + right.output_tokens,
        reasoning_tokens=left.reasoning_tokens + right.reasoning_tokens,
        cached_tokens=left.cached_tokens + right.cached_tokens,
        cost_usd=None
        if left.cost_usd is None or right.cost_usd is None
        else left.cost_usd + right.cost_usd,
    )


@dataclass(frozen=True)
class AiResult(Generic[T]):
    value: T
    usage: ProviderUsage
    actual_model_id: str
    requested_model_id: str
    run_id: str
    duration_ms: int


@dataclass(frozen=True)
class AiTextRequest(Generic[T]):
    role: str
    messages: list[dict[str, str]]
    response_model: type[T]
    job_id: str | None = None
    parameters: dict[str, object] | None = None
    request_model_override: AiModelSelection | None = None


class AiClient:
    def __init__(
        self,
        transport: OpenAICompatibleTransport | None = None,
        *,
        retry_backoff: tuple[float, ...] = (2, 6, 15),
    ) -> None:
        self.transport = transport
        self.retry_backoff = retry_backoff
        self.selections: dict[str, dict | None] = {}

    def bind_job(self, job_id: str):
        from app.models import Deck, GenerationJob

        with session_factory()() as session:
            job = session.get(GenerationJob, job_id)
            deck = session.get(Deck, job.deck_id) if job else None
            self.selections = (
                deck.options.get("imports", {}).get(job_id, {}).get("models", {}) if deck else {}
            )
        return self

    def resolve(self, role: str, request_override: AiModelSelection | None = None) -> ResolvedModel:
        with session_factory()() as session:
            pinned = self.selections.get(role)
            if role in self.selections and pinned is None:
                raise AiGatewayError(
                    "Для этой задачи разбор моделью был выключен", code="ai_role_disabled"
                )
            resolved = resolve_model(
                session,
                role,
                request_override,
                pinned_selection=AiModelSelection.model_validate(pinned) if pinned else None,
            )
            session.commit()
            session.expunge_all()
            return resolved

    async def complete(self, request: AiTextRequest[T] | None = None, **kwargs) -> T:
        return (await self.complete_result(request, **kwargs)).value

    async def generate(self, **kwargs) -> T:
        return await self.complete(**kwargs)

    def _check_operation_limit(self, job_id, usage):
        with session_factory()() as session:
            settings = session.get(AiSettings, 1)
            limit = settings.operation_limit_usd if settings else get_settings().operation_limit_usd
            spent = (
                (
                    session.scalar(select(func.sum(AiCall.cost_usd)).where(AiCall.job_id == job_id))
                    or 0
                )
                if job_id
                else 0
            )
            if limit is not None and spent + (usage.cost_usd or 0) >= limit:
                raise AiGatewayError(
                    "Достигнут лимит стоимости этой операции", code="ai_operation_limit", status=409
                )

    async def complete_result(
        self,
        request: AiTextRequest[T] | None = None,
        *,
        role: str | None = None,
        messages: list[dict[str, str]] | None = None,
        response_model: type[T] | None = None,
        job_id: str | None = None,
        parameters: dict[str, object] | None = None,
        request_model_override: AiModelSelection | None = None,
    ) -> AiResult[T]:
        if request is not None:
            role, messages, response_model = request.role, request.messages, request.response_model
            job_id, parameters = request.job_id, request.parameters
            request_model_override = request.request_model_override
        if role is None or response_model is None or messages is None:
            raise AiGatewayError(
                "Для вызова нужны роль, сообщения и схема ответа",
                code="ai_response_schema_missing",
                status=422,
            )
        resolved = self.resolve(role, request_model_override)
        with session_factory()() as session:
            if resolved.provider.executor_kind == "mcp":
                from app.mcp_bridge.executor import ExternalChatExecutor

                transport = self.transport or ExternalChatExecutor(job_id)
            else:
                transport = self.transport or production_transport(session, resolved.provider.id)
        schema = _without_unsupported_keywords(to_strict_json_schema(response_model))
        values = validate_role_parameters(role, resolved.parameters | (parameters or {}))
        maximum = int(values.pop("max_output_tokens"))
        if resolved.model.max_completion_tokens is not None:
            maximum = min(maximum, resolved.model.max_completion_tokens)
        supported = resolved.model.supported_parameters
        # Каталог подписки задаёт реальные возможности установленного CLI.
        # Если off недоступен, выбираем low, а не личный/default high.
        if resolved.is_subscription and (efforts := resolved.model.reasoning.get("efforts")):
            efforts = [e.get("reasoningEffort") if isinstance(e, dict) else e for e in efforts]
            requested = values.get("reasoning_effort")
            if ("none" if requested == "off" else requested) not in efforts:
                values["reasoning_effort"] = (
                    "off" if "none" in efforts else "low" if "low" in efforts else efforts[0]
                )
        if not resolved.model.reasoning and not any(
            key in supported for key in ("reasoning", "reasoning_effort")
        ):
            values.pop("reasoning_effort", None)
        if supported:
            values = {
                k: v
                for k, v in values.items()
                if k in supported or (k == "reasoning_effort" and "reasoning" in supported)
            }
        mode = resolved.model.structured_mode or "json_schema"
        dialog = [dict(item) for item in messages]
        usage = ProviderUsage(cost_usd=None if resolved.is_subscription else Decimal(0))
        invalid_retried = False
        sampling_dropped = False
        provider_retries = 0
        started = time.monotonic()
        try:
            while True:
                if not resolved.is_subscription:
                    self._check_operation_limit(job_id, usage)
                current_dialog = [dict(item) for item in dialog]
                if mode != "json_schema":
                    current_dialog.append(
                        {
                            "role": "user",
                            "content": "Верни только JSON строго по схеме: "
                            + json.dumps(schema, ensure_ascii=False),
                        }
                    )
                try:
                    completion = await transport.complete(
                        model=resolved.model_id,
                        messages=current_dialog,
                        response_schema=schema,
                        max_output_tokens=maximum,
                        parameters=dict(values),
                        mode=mode,
                    )
                except ProviderError as error:
                    if error.usage is not None:
                        usage = _sum_usage(usage, error.usage)
                    detail = error.detail.casefold()
                    if (
                        error.code == "ai_request_rejected"
                        and any(
                            marker in detail
                            for marker in (
                                "response_format",
                                "json_schema",
                                "json_object",
                                "structured output",
                            )
                        )
                        and mode != "prompt"
                    ):
                        mode = "json_object" if mode == "json_schema" else "prompt"
                        continue
                    if (
                        error.code == "ai_request_rejected"
                        and not sampling_dropped
                        and any(k in detail for k in SAMPLING_PARAMETERS)
                        and any(k in values for k in SAMPLING_PARAMETERS)
                    ):
                        values = {k: v for k, v in values.items() if k not in SAMPLING_PARAMETERS}
                        sampling_dropped = True
                        continue
                    if (
                        not resolved.is_subscription
                        and error.code in RETRYABLE_PROVIDER_CODES
                        and provider_retries < len(self.retry_backoff)
                    ):
                        await asyncio.sleep(self.retry_backoff[provider_retries])
                        provider_retries += 1
                        continue
                    raise AiGatewayError(
                        error.detail, code=error.code, status=provider_status(error.code)
                    ) from error
                cost = completion.usage.cost_usd
                if cost is None:
                    cost = estimate_cost(
                        completion.usage.input_tokens, completion.usage.output_tokens, resolved
                    )
                received = ProviderUsage(
                    completion.usage.input_tokens,
                    completion.usage.output_tokens,
                    completion.usage.reasoning_tokens,
                    completion.usage.cached_tokens,
                    cost,
                )
                usage = _sum_usage(usage, received)
                try:
                    value = response_model.model_validate_json(clean_json(completion.content))
                except (ValidationError, ValueError) as error:
                    if not invalid_retried:
                        invalid_retried = True
                        dialog.extend(
                            [
                                {"role": "assistant", "content": completion.content[:1000]},
                                {
                                    "role": "user",
                                    "content": f"Ответ не прошёл проверку: {str(error)[:500]}. Исправь и верни только JSON по той же схеме.",
                                },
                            ]
                        )
                        continue
                    raise AiGatewayError(
                        "Ответ модели не прошёл структурную проверку",
                        code="ai_invalid_structured_output",
                        status=502,
                    ) from error
                duration = int((time.monotonic() - started) * 1000)
                call_id = self._record(
                    role, resolved, job_id, usage, duration, "succeeded", mode=mode
                )
                return AiResult(
                    value, usage, completion.actual_model_id, resolved.model_id, call_id, duration
                )
        except AiGatewayError as error:
            self._record(
                role,
                resolved,
                job_id,
                usage,
                int((time.monotonic() - started) * 1000),
                "failed",
                error_code=error.code,
            )
            raise
        except asyncio.CancelledError:
            self._record(
                role, resolved, job_id, usage, int((time.monotonic() - started) * 1000), "cancelled"
            )
            raise
        finally:
            if self.transport is None and hasattr(transport, "client"):
                await transport.client.close()

    def _record(
        self, role, resolved, job_id, usage, duration, status, *, mode=None, error_code=None
    ) -> str:
        with session_factory()() as session:
            row = AiCall(
                role=role,
                provider_id=resolved.provider.id,
                model_id=resolved.model_id,
                status=status,
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cost_usd=usage.cost_usd,
                duration_ms=duration,
                job_id=job_id,
                error_code=error_code,
            )
            session.add(row)
            if mode:
                model = session.get(AiModelCatalogEntry, (resolved.provider.id, resolved.model_id))
                if model is not None:
                    model.structured_mode = mode
            session.commit()
            return row.id

    async def test_model(self, selection: AiModelSelection) -> AiModelTestRead:
        class ModelAnswer(BaseModel):
            answer: str

        result = await self.complete_result(
            role="settings_model_test",
            messages=[
                {"role": "user", "content": "Напиши короткое приветствие на русском в поле answer."}
            ],
            response_model=ModelAnswer,
            request_model_override=selection,
        )
        return AiModelTestRead(
            status="answered",
            run_id=result.run_id,
            duration_ms=result.duration_ms,
            answer=result.value.answer,
            actual_model_id=result.actual_model_id,
            input_tokens=result.usage.input_tokens,
            output_tokens=result.usage.output_tokens,
        )
