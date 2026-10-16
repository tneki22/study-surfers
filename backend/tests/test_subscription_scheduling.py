import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

from test_subscriptions import subscription as subscription

from app.ai.client import AiClient
from app.ai.models import AiCall
from app.ai.subscriptions import SubscriptionTransport
from app.db import session_factory
from app.models import Deck, GenerationJob
from app.pipeline.jobs import JobManager, LimitedExtractClient, job_read


def test_subscription_extract_uses_low_effort_and_cloud_queue(subscription):
    resolved = AiClient().resolve("extract")
    assert resolved.parameters["reasoning_effort"] == "low"
    assert not resolved.serial_execution


async def test_subscription_allows_two_requests_and_bounds_concurrency(monkeypatch):
    import app.ai.subscriptions as subscriptions

    monkeypatch.setattr(subscriptions, "claude_account", AsyncMock(return_value={}))
    entered, active, maximum = 0, 0, 0
    two_started, release = asyncio.Event(), asyncio.Event()

    async def run(*args):
        nonlocal entered, active, maximum
        entered += 1
        active += 1
        maximum = max(maximum, active)
        if entered == 2:
            two_started.set()
        try:
            await release.wait()
            return (
                0,
                json.dumps(
                    {"type": "result", "subtype": "success", "structured_output": {"ok": True}}
                ),
                "",
            )
        finally:
            active -= 1

    monkeypatch.setattr(subscriptions, "claude_run", run)
    tasks = [
        asyncio.create_task(
            SubscriptionTransport("claude").complete(
                model="haiku", messages=[], response_schema={}, parameters={}
            )
        )
        for _ in range(3)
    ]
    try:
        await asyncio.wait_for(two_started.wait(), 1)
        assert entered == 2
    finally:
        release.set()
        await asyncio.gather(*tasks)
    assert entered == 3
    assert maximum == 2


async def test_large_subscription_import_leaves_room_for_another_job():
    manager = JobManager()
    release, other_started = asyncio.Event(), asyncio.Event()
    first_active = 0

    class Client:
        def __init__(self, job_id):
            self.job_id = job_id

        def resolve(self, role):
            return SimpleNamespace(is_subscription=True, serial_execution=False)

        async def complete(self, **kwargs):
            nonlocal first_active
            if self.job_id == "first":
                first_active += 1
            else:
                other_started.set()
            await release.wait()

    first = LimitedExtractClient(Client("first"), manager)
    other = LimitedExtractClient(Client("other"), manager)
    tasks = [asyncio.create_task(first.complete(role="extract")) for _ in range(10)]
    tasks.append(asyncio.create_task(other.complete(role="extract")))
    try:
        await asyncio.wait_for(other_started.wait(), 1)
        assert first_active == 2
    finally:
        release.set()
        await asyncio.gather(*tasks)


def test_structuring_reports_completed_requests(client):
    with session_factory()() as session:
        deck = Deck(id="progress-deck", title="Конспект", source_kind="upload")
        session.add(deck)
        session.flush()
        job = GenerationJob(
            id="progress-job", deck_id=deck.id, kind="quick_import", state="structuring"
        )
        session.add(job)
        session.flush()
        for role, status in [
            ("extract", "succeeded"),
            ("extract", "failed"),
            ("generate", "succeeded"),
        ]:
            session.add(AiCall(job_id=job.id, role=role, model_id="test", status=status))
        session.commit()
        assert job_read(session, job).stage_label.endswith("выполнено запросов: 1")
