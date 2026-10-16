from decimal import Decimal
from uuid import uuid4

import httpx
import pytest
from openai import AsyncOpenAI

from app.ai import catalog, settings
from app.ai.errors import AiGatewayError
from app.ai.models import AiModelCatalogEntry
from app.ai.provider import FakeTransport, OpenAITransport, ProviderError, ProviderModel
from app.ai.schemas import AiManualModelWrite, AiProviderWrite
from app.db import session_factory


@pytest.fixture
def provider(client):
    with session_factory()() as session:
        return (
            settings.create_provider(
                session, AiProviderWrite(label="LM Studio", base_url="http://localhost:1234/v1")
            )
            .providers[0]
            .id
        )


async def test_connection_then_search_no_database_transaction_during_network(provider):
    with session_factory()() as session:

        class ObservingTransport(FakeTransport):
            async def list_models(self):
                assert not session.in_transaction()
                return await super().list_models()

        fake = ObservingTransport(
            models=[
                ProviderModel("model-b", "Бета", prompt_price_usd=Decimal(-1)),
                ProviderModel("model-a", "Альфа"),
            ]
        )
        result = await catalog.test_connection(session, provider, fake)
        assert result.status == "connected" and result.model_count == 2
        models = await catalog.search_catalog(session, provider, fake)
        assert [m.model_id for m in models] == ["model-a", "model-b"]
        assert models[1].prompt_price_usd is None
        assert all(not m.is_added for m in models)


async def test_catalog_refresh_preserves_manual_overrides_favorite_and_mode(provider):
    with session_factory()() as session:
        settings.upsert_manual_model(
            session,
            provider,
            AiManualModelWrite(model_id="test", display_name="Своё название", context_length=12345),
        )
        row = session.get(AiModelCatalogEntry, (provider, "test"))
        row.favorite_order = 2
        row.structured_mode = "prompt"
        session.commit()
        from app.ai.models import utc_now

        catalog._upsert_model(
            session,
            provider,
            ProviderModel("test", "Каталожное название", context_length=9999),
            utc_now(),
        )
        session.commit()
        row = session.get(AiModelCatalogEntry, (provider, "test"))
        assert row.display_name == "Своё название" and row.context_length == 12345
        assert row.favorite_order == 2 and row.structured_mode == "prompt"
        models = await catalog.search_catalog(
            session, provider, FakeTransport(models=[ProviderModel("test", "Тест")])
        )
        assert models[0].is_added is True


async def test_failed_connection_records_failure(provider):
    class Failure(FakeTransport):
        async def list_models(self):
            raise ProviderError("ai_invalid_credentials", "Неверный ключ")

    with session_factory()() as session:
        with pytest.raises(AiGatewayError) as raised:
            await catalog.test_connection(session, provider, Failure())
        assert raised.value.status_code == 401
        assert (
            settings.read_settings(session).providers[0].last_test_status
            == "ai_invalid_credentials"
        )


async def test_models_transport_reads_openrouter_metadata():
    async def handler(request):
        return httpx.Response(
            200,
            json={
                "data": [
                    {
                        "id": "qwen/test",
                        "name": "Qwen",
                        "context_length": 16384,
                        "top_provider": {"max_completion_tokens": 8192},
                        "supported_parameters": ["temperature"],
                        "pricing": {"prompt": "0.000001", "completion": "0.000002"},
                        "architecture": {
                            "input_modalities": ["text"],
                            "output_modalities": ["text"],
                        },
                    }
                ]
            },
        )

    transport = OpenAITransport("http://localhost:1234/v1", "")
    await transport.client.close()
    transport.client = AsyncOpenAI(
        api_key=str(uuid4()),
        base_url="http://localhost:1234/v1",
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)),
    )
    model = (await transport.list_models())[0]
    assert model.model_id == "qwen/test" and model.context_length == 16384
    assert model.prompt_price_usd == Decimal("0.000001") and model.max_completion_tokens == 8192
    await transport.client.close()
