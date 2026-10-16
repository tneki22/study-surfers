import json
from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from openai import (
    APIConnectionError,
    APIStatusError,
    APITimeoutError,
    AuthenticationError,
    RateLimitError,
)
from pydantic import BaseModel, Field
from sqlalchemy import select

from app.ai.client import AiClient, _without_unsupported_keywords
from app.ai.errors import AiGatewayError
from app.ai.models import AiCall, AiModelCatalogEntry, AiProviderConnection, AiSettings, utc_now
from app.ai.provider import (
    FakeTransport,
    OpenAITransport,
    ProviderCompletion,
    ProviderError,
    ProviderUsage,
    normalize_provider_error,
)
from app.db import Base, get_engine, session_factory


class Answer(BaseModel):
    answer: str


@pytest.fixture
def configured(client):
    Base.metadata.create_all(get_engine())
    provider_id = str(uuid4())
    with session_factory()() as session:
        session.add(
            AiProviderConnection(
                id=provider_id, label="Локальный", base_url="http://localhost:1234/v1"
            )
        )
        session.flush()
        session.add(
            AiModelCatalogEntry(
                provider_id=provider_id,
                model_id="test-model",
                display_name="Тестовая",
                pricing_snapshot_at=utc_now(),
                catalog_snapshot_at=utc_now(),
                prompt_price_usd=Decimal("0.000001"),
                completion_price_usd=Decimal("0.000002"),
            )
        )
        row = session.get(AiSettings, 1)
        if row is None:
            row = AiSettings(id=1)
            session.add(row)
        row.external_models_enabled = True
        row.default_text_provider_id = provider_id
        row.default_text_model_id = "test-model"
        session.commit()
    return provider_id


def completion(content='{"answer":"готово"}'):
    return ProviderCompletion(content, "test-model", ProviderUsage(10, 20))


async def call(transport):
    return await AiClient(transport, retry_backoff=(0, 0, 0)).complete(
        role="generate", messages=[{"role": "user", "content": "Тест"}], response_model=Answer
    )


async def test_complete_sends_provider_strict_schema(configured):
    fake = FakeTransport(completions=[completion()])
    assert (await call(fake)).answer == "готово"
    schema = fake.complete_requests[0]["response_schema"]
    assert schema["additionalProperties"] is False and schema["required"] == ["answer"]
    assert "reasoning_effort" not in fake.complete_requests[0]["parameters"]


@pytest.mark.parametrize(
    ("efforts", "override", "expected"),
    [
        (["low", "high"], None, "low"),
        (["none", "low"], None, "off"),
        (["none", "low", "high"], "high", "high"),
    ],
)
async def test_subscription_fast_default_respects_capabilities_and_override(
    configured, efforts, override, expected
):
    with session_factory()() as session:
        provider = session.get(AiProviderConnection, configured)
        provider.executor_kind = "codex"
        model = session.get(AiModelCatalogEntry, (configured, "test-model"))
        model.supported_parameters = ["reasoning_effort"]
        model.reasoning = {"efforts": efforts}
        session.commit()
    fake = FakeTransport(completions=[completion()])
    await AiClient(fake).complete(
        role="generate",
        messages=[],
        response_model=Answer,
        parameters={"reasoning_effort": override} if override else {},
    )
    assert fake.complete_requests[0]["parameters"]["reasoning_effort"] == expected


async def test_fallback_to_json_object(configured):
    fake = FakeTransport(
        completions=[
            ProviderError("ai_request_rejected", "response_format unsupported"),
            completion(),
        ]
    )
    await call(fake)
    assert [r["mode"] for r in fake.complete_requests] == ["json_schema", "json_object"]


async def test_fallback_modes_and_remember_success(configured):
    fake = FakeTransport(
        completions=[
            ProviderError("ai_request_rejected", "response_format json_schema unsupported"),
            ProviderError("ai_request_rejected", "response_format json_object unsupported"),
            completion(),
            completion(),
        ]
    )
    await call(fake)
    await call(fake)
    assert [r["mode"] for r in fake.complete_requests] == [
        "json_schema",
        "json_object",
        "prompt",
        "prompt",
    ]
    assert "Верни только JSON" in fake.complete_requests[2]["messages"][-1]["content"]
    with session_factory()() as session:
        assert (
            session.get(AiModelCatalogEntry, (configured, "test-model")).structured_mode == "prompt"
        )


async def test_think_and_fences_are_removed(configured):
    fake = FakeTransport(
        completions=[completion('<think>размышление</think>\n```json\n{"answer":"да"}\n```')]
    )
    assert (await call(fake)).answer == "да"


async def test_client_rejection_is_final_and_costs_nothing(configured):
    fake = FakeTransport(
        completions=[
            ProviderError(
                "ai_request_rejected", "Неверная модель", usage=ProviderUsage(cost_usd=Decimal(0))
            )
        ]
    )
    with pytest.raises(AiGatewayError) as raised:
        await call(fake)
    assert raised.value.code == "ai_request_rejected" and fake.complete_calls == 1
    with session_factory()() as session:
        row = session.scalar(select(AiCall))
        assert row.status == "failed" and row.cost_usd == 0


async def test_retries_once_on_invalid_json_then_succeeds(configured):
    fake = FakeTransport(completions=[completion("сломанный JSON"), completion()])
    assert (await call(fake)).answer == "готово"
    assert len(fake.complete_requests[1]["messages"]) == 3
    with session_factory()() as session:
        row = session.scalar(select(AiCall))
        assert (
            row.input_tokens == 20 and row.output_tokens == 40 and row.cost_usd == Decimal("0.0001")
        )


async def test_invalid_json_retry_is_bounded(configured):
    fake = FakeTransport(completions=[completion("bad"), completion("bad"), completion()])
    with pytest.raises(AiGatewayError, match="структурную"):
        await call(fake)
    assert fake.complete_calls == 2


async def test_retries_on_retryable_provider_error_then_succeeds(configured):
    fake = FakeTransport(completions=[ProviderError("ai_rate_limited", "Подождите"), completion()])
    await call(fake)
    assert fake.complete_calls == 2


async def test_unsupported_sampling_parameters_are_dropped(configured):
    fake = FakeTransport(
        completions=[ProviderError("ai_request_rejected", "temperature unsupported"), completion()]
    )
    await call(fake)
    assert (
        "temperature" in fake.complete_requests[0]["parameters"]
        and "temperature" not in fake.complete_requests[1]["parameters"]
    )


def test_schema_drops_numeric_bounds_but_keeps_field_names():
    class Bounds(BaseModel):
        minimum: int = Field(ge=1, le=10)
        maximum: str = Field(min_length=1)

    from openai.lib._pydantic import to_strict_json_schema

    schema = _without_unsupported_keywords(to_strict_json_schema(Bounds))
    assert set(schema["properties"]) == {"minimum", "maximum"}
    assert schema["properties"]["minimum"] == {"type": "integer", "title": "Minimum"}


def status_error(status, error_class=APIStatusError, body=None):
    response = httpx.Response(status, request=httpx.Request("POST", "https://example.com/v1"))
    return error_class("error", response=response, body=body)


def test_openrouter_nested_provider_error_is_explained():
    error = status_error(
        400,
        body={
            "error": {
                "message": "Provider returned error",
                "metadata": {
                    "raw": json.dumps({"error": {"message": "response_format unsupported"}})
                },
            }
        },
    )
    result = normalize_provider_error(error)
    assert result.code == "ai_request_rejected" and "response_format unsupported" in result.detail


@pytest.mark.parametrize(
    "error,code",
    [
        (status_error(401, AuthenticationError), "ai_invalid_credentials"),
        (status_error(429, RateLimitError), "ai_rate_limited"),
        (status_error(503), "ai_provider_unavailable"),
        (status_error(409), "ai_provider_unavailable"),
        (status_error(400), "ai_request_rejected"),
        (APITimeoutError(request=httpx.Request("GET", "https://example.com")), "ai_timeout"),
        (
            APIConnectionError(request=httpx.Request("GET", "https://example.com")),
            "ai_provider_unavailable",
        ),
    ],
)
def test_provider_errors_are_normalized(error, code):
    assert normalize_provider_error(error).code == code


async def test_real_transport_request_shape():
    requests = []

    async def handler(request):
        requests.append(json.loads(request.content))
        return httpx.Response(
            200,
            json={
                "id": "test",
                "model": "test-model",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": '{"answer":"да"}'},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": 5, "completion_tokens": 10},
            },
        )

    transport = OpenAITransport("http://localhost:1234/v1", "")
    from openai import AsyncOpenAI

    await transport.client.close()
    transport.client = AsyncOpenAI(
        api_key="not-needed",
        base_url="http://localhost:1234/v1",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    for mode in ("json_schema", "json_object", "prompt"):
        await transport.complete(
            model="test-model",
            messages=[{"role": "user", "content": "JSON"}],
            response_schema={"type": "object"},
            max_output_tokens=100,
            parameters={},
            mode=mode,
        )
    assert requests[0]["response_format"]["json_schema"]["name"] == "study_surfers_result"
    assert (
        requests[1]["response_format"] == {"type": "json_object"}
        and "response_format" not in requests[2]
    )
    await transport.client.close()
