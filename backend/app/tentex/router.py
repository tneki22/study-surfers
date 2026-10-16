from uuid import UUID

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app.ai.schemas import AiSettingsRead
from app.ai.settings import resolve_model
from app.db import get_session
from app.tentex.reader import TentexReader
from app.tentex.schemas import (
    TentexImportResult,
    TentexProject,
    TentexProjectImport,
    TentexProvider,
    TentexProvidersImport,
    TentexStatus,
)
from app.tentex.service import import_project, import_providers, list_providers

router = APIRouter(prefix="/api/tentex", tags=["Tentex"])


@router.get("/status", response_model=TentexStatus)
def tentex_status():
    return TentexReader().status()


@router.get("/projects", response_model=list[TentexProject])
def tentex_projects(force: bool = False):
    return TentexReader().projects(force=force)


@router.post("/projects/{project_id}/import", response_model=TentexImportResult, status_code=202)
async def tentex_import_project(
    project_id: UUID,
    body: TentexProjectImport,
    force: bool = False,
    session: Session = Depends(get_session),
):
    # Модель проверяется до создания колоды и запуска фоновой задачи.
    resolve_model(session, "generate")
    deck, job = import_project(session, str(project_id), body, force=force)
    from app.pipeline.jobs import start_job

    start_job(job.id)
    return {"deck_id": deck.id, "job_id": job.id}


@router.get("/providers", response_model=list[TentexProvider])
def tentex_providers(force: bool = False, session: Session = Depends(get_session)):
    return list_providers(session, force=force)


@router.post("/providers/import", response_model=AiSettingsRead)
def tentex_import_providers(
    body: TentexProvidersImport, force: bool = False, session: Session = Depends(get_session)
):
    return import_providers(session, body, force=force)
