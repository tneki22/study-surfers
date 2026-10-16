from typing import Literal

from pydantic import BaseModel


class AiPresetRead(BaseModel):
    key: str
    label: str
    base_url: str
    catalog_profile: Literal["openrouter", "openai_compatible"]
    requires_key: bool
    key_hint: str


PRESETS = [
    AiPresetRead(
        key="openrouter",
        label="OpenRouter",
        base_url="https://openrouter.ai/api/v1",
        catalog_profile="openrouter",
        requires_key=True,
        key_hint="Ключ из личного кабинета OpenRouter",
    ),
    AiPresetRead(
        key="openai",
        label="OpenAI",
        base_url="https://api.openai.com/v1",
        catalog_profile="openai_compatible",
        requires_key=True,
        key_hint="Ключ OpenAI API",
    ),
    AiPresetRead(
        key="lmstudio",
        label="LM Studio",
        base_url="http://localhost:1234/v1",
        catalog_profile="openai_compatible",
        requires_key=False,
        key_hint="Включите локальный сервер LM Studio",
    ),
    AiPresetRead(
        key="ollama",
        label="Ollama",
        base_url="http://localhost:11434/v1",
        catalog_profile="openai_compatible",
        requires_key=False,
        key_hint="Для длинных материалов задайте OLLAMA_CONTEXT_LENGTH ≥ 16384",
    ),
    AiPresetRead(
        key="custom",
        label="Другой провайдер",
        base_url="",
        catalog_profile="openai_compatible",
        requires_key=True,
        key_hint="OpenAI-совместимый адрес и ключ провайдера",
    ),
]
