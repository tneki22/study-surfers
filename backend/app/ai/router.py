"""Настройки провайдеров, моделей и функций ИИ."""

from __future__ import annotations

from typing import Annotated

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.orm import Session

from app.ai import catalog, settings
from app.ai.client import AiClient
from app.ai.presets import PRESETS, AiPresetRead
from app.ai.schemas import (
    AiCatalogModelRead,
    AiCatalogModelWrite,
    AiDefaultWrite,
    AiGlobalSettingsWrite,
    AiManualModelWrite,
    AiModelFavoritesWrite,
    AiModelSelection,
    AiModelTestRead,
    AiModelTestWrite,
    AiProviderFavoritesWrite,
    AiProviderTestRead,
    AiProviderWrite,
    AiRoleWrite,
    AiSettingsRead,
)
from app.db import get_session

SessionDependency = Annotated[Session, Depends(get_session)]
router = APIRouter(prefix="/api/settings/ai", tags=["ai-settings"])


@router.get("", response_model=AiSettingsRead)
def get_ai_settings(session: SessionDependency) -> AiSettingsRead:
    return settings.read_settings(session)


@router.put("", response_model=AiSettingsRead)
def put_ai_settings(command: AiGlobalSettingsWrite, session: SessionDependency) -> AiSettingsRead:
    return settings.update_global_settings(session, command)


@router.post("/providers", response_model=AiSettingsRead, status_code=status.HTTP_201_CREATED)
def post_ai_provider(command: AiProviderWrite, session: SessionDependency) -> AiSettingsRead:
    return settings.create_provider(session, command)


@router.put("/providers/{provider_id}", response_model=AiSettingsRead)
def put_ai_provider(
    provider_id: str, command: AiProviderWrite, session: SessionDependency
) -> AiSettingsRead:
    return settings.update_provider(session, provider_id, command)


@router.delete("/providers/{provider_id}", response_model=AiSettingsRead)
def delete_ai_provider(provider_id: str, session: SessionDependency) -> AiSettingsRead:
    return settings.delete_provider(session, provider_id)


@router.delete("/providers/{provider_id}/credential", status_code=status.HTTP_204_NO_CONTENT)
def delete_ai_credential(provider_id: str, session: SessionDependency) -> Response:
    settings.delete_credential(session, provider_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/providers/{provider_id}/test", response_model=AiProviderTestRead)
async def test_ai_provider(provider_id: str, session: SessionDependency) -> AiProviderTestRead:
    return await catalog.test_connection(session, provider_id)


@router.post("/providers/{provider_id}/models/search", response_model=list[AiCatalogModelRead])
async def search_ai_models(
    provider_id: str, session: SessionDependency
) -> list[AiCatalogModelRead]:
    return await catalog.search_catalog(session, provider_id)


@router.post("/providers/{provider_id}/models", response_model=AiSettingsRead)
def add_ai_catalog_model(
    provider_id: str,
    command: AiCatalogModelWrite,
    session: SessionDependency,
) -> AiSettingsRead:
    return catalog.add_catalog_model(session, provider_id, command)


@router.put("/providers/{provider_id}/models/manual", response_model=AiSettingsRead)
def put_manual_ai_model(
    provider_id: str,
    command: AiManualModelWrite,
    session: SessionDependency,
) -> AiSettingsRead:
    return settings.upsert_manual_model(session, provider_id, command)


@router.delete("/providers/{provider_id}/models", response_model=AiSettingsRead)
def delete_ai_model(
    provider_id: str,
    # ID модели содержит «/», поэтому он приходит параметром запроса, а не частью пути.
    model_id: Annotated[str, Query(min_length=1)],
    session: SessionDependency,
) -> AiSettingsRead:
    return settings.delete_model(session, provider_id, model_id)


@router.post("/providers/{provider_id}/models/test", response_model=AiModelTestRead)
async def test_ai_model(
    provider_id: str,
    command: AiModelTestWrite,
    session: SessionDependency,
) -> AiModelTestRead:
    return await AiClient().test_model(
        AiModelSelection(provider_id=provider_id, model_id=command.model_id)
    )


@router.put("/provider-favorites", response_model=AiSettingsRead)
def put_ai_provider_favorites(
    command: AiProviderFavoritesWrite, session: SessionDependency
) -> AiSettingsRead:
    return settings.update_provider_favorites(session, command)


@router.put("/model-favorites", response_model=AiSettingsRead)
def put_ai_model_favorites(
    command: AiModelFavoritesWrite, session: SessionDependency
) -> AiSettingsRead:
    return settings.update_model_favorites(session, command)


@router.put("/defaults/text", response_model=AiSettingsRead)
def put_ai_default(command: AiDefaultWrite, session: SessionDependency) -> AiSettingsRead:
    return settings.set_default(session, "text", command)


@router.put("/roles/{role}", response_model=AiSettingsRead)
def put_ai_role(role: str, command: AiRoleWrite, session: SessionDependency) -> AiSettingsRead:
    return settings.update_role(session, role, command)


@router.get("/presets", response_model=list[AiPresetRead])
def get_ai_presets() -> list[AiPresetRead]:
    return PRESETS
