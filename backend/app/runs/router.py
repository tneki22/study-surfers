from fastapi import APIRouter, Query, Response
from sqlalchemy import select

from app.decks.router import DB
from app.decks.service import require_deck
from app.models import RUN_NEWEST_FIRST, Run
from app.runs import service
from app.runs.schemas import DeckStats, RunCreate, RunDetail, RunSummary

router = APIRouter(prefix="/api", tags=["Забеги"])


@router.post(
    "/runs", response_model=RunDetail, status_code=201, responses={200: {"model": RunDetail}}
)
def create_run(body: RunCreate, session: DB, response: Response):
    result, created = service.save_run(session, body)
    response.status_code = 201 if created else 200
    return result


@router.get("/decks/{deck_id}/runs", response_model=list[RunSummary])
def list_runs(
    deck_id: str,
    session: DB,
    limit: int = Query(20, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    require_deck(session, deck_id)
    return [
        service.run_summary(r)
        for r in session.scalars(
            select(Run)
            .where(Run.deck_id == deck_id)
            .order_by(*RUN_NEWEST_FIRST)
            .limit(limit)
            .offset(offset)
        )
    ]


@router.get("/runs/{run_id}", response_model=RunDetail)
def get_run(run_id: str, session: DB):
    return service.run_detail(session, service.require_run(session, run_id))


@router.get("/decks/{deck_id}/stats", response_model=DeckStats)
def get_deck_stats(deck_id: str, session: DB):
    return service.deck_stats(session, deck_id)
