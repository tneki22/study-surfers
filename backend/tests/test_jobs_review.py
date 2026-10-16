import asyncio
from decimal import Decimal

import pytest
from sqlalchemy import select
from test_ai_client import Answer
from test_ai_client import configured as configured_model

from app.ai.client import AiClient
from app.ai.models import AiCall, AiSettings
from app.ai.provider import FakeTransport, ProviderCompletion, ProviderUsage
from app.core.errors import DomainError
from app.db import session_factory
from app.models import Deck, GenerationJob, Question, uid
from app.pipeline import jobs
from app.pipeline.generate import GeneratedBatch

configured = configured_model


def queued_job():
    with session_factory()() as session:
        deck = Deck(id=uid(), title="Проверка отмены")
        session.add(deck)
        session.flush()
        question = Question(id=uid(), deck_id=deck.id, ordinal=1, text="Проверяемый вопрос")
        session.add(question)
        job = GenerationJob(id=uid(), deck_id=deck.id, kind="regen_question", total=1)
        session.add(job)
        session.commit()
        return deck.id, job.id, question.id


async def test_cancel_immediately_after_start_reaches_cancelled(client):
    _, job_id, _ = queued_job()
    manager = jobs.JobManager()
    manager.start(job_id)
    try:
        # Между start и cancel нет yield: основная корутина ещё не начала исполнение.
        await manager.cancel(job_id)
        with session_factory()() as session:
            row = session.get(GenerationJob, job_id)
            assert row.state == "cancelled"
            assert row.cancel_requested is True and row.finished_at is not None
        jobs.transition_job(job_id, "resume")
        with session_factory()() as session:
            row = session.get(GenerationJob, job_id)
            assert row.state == "queued" and row.cancel_requested is False
    finally:
        await manager.close()


async def test_writer_drops_cancelled_job_batch_and_resolves_waiter(client):
    _, job_id, question_id = queued_job()
    with session_factory()() as session:
        row = session.get(GenerationJob, job_id)
        row.state = "cancelled"
        row.cancel_requested = True
        session.commit()
    manager = jobs.JobManager()
    manager.writer = asyncio.create_task(manager._writer())
    future = asyncio.get_running_loop().create_future()
    await manager.queue.put(jobs.WriteRequest(job_id, question_id, GeneratedBatch([], []), future))
    try:
        await asyncio.wait_for(future, 1)
        await asyncio.wait_for(manager.queue.join(), 1)
        with session_factory()() as session:
            row = session.get(GenerationJob, job_id)
            assert row.done == 0 and row.state == "cancelled"
            assert session.get(Question, question_id).status == "pending"
    finally:
        await manager.close()


async def test_old_finished_task_callback_does_not_remove_replacement_task(client):
    _, job_id, _ = queued_job()
    manager = jobs.JobManager()
    reached_wait = asyncio.Event()
    release = asyncio.Event()

    async def controlled_run(_):
        reached_wait.set()
        await release.wait()

    manager._run = controlled_run
    original = manager.start(job_id)
    try:
        await reached_wait.wait()
        release.set()
        # Сначала ставим waiter; done callback старой задачи должен ещё оставаться в очереди.
        while not original.done():
            await asyncio.sleep(0)
        release.clear()
        replacement = manager.start(job_id)
        await asyncio.sleep(0)
        assert manager.tasks.get(job_id) is replacement
    finally:
        release.set()
        await manager.close()


async def test_paid_invalid_json_retry_stops_at_operation_limit(configured):
    _, job_id, _ = queued_job()
    with session_factory()() as session:
        session.get(AiSettings, 1).operation_limit_usd = Decimal("0.00001")
        session.commit()
    fake = FakeTransport(
        completions=[
            ProviderCompletion("invalid JSON", "test-model", ProviderUsage(10, 20)),
            ProviderCompletion('{"answer":"готово"}', "test-model", ProviderUsage(10, 20)),
        ]
    )
    bound = jobs.BoundClient(AiClient(fake), job_id)
    with pytest.raises(DomainError) as raised:
        await bound.complete(
            role="generate",
            response_model=Answer,
            messages=[{"role": "user", "content": "Проверка"}],
        )
    assert raised.value.code == "ai_operation_limit"
    assert fake.complete_calls == 1
    with session_factory()() as session:
        call = session.scalar(select(AiCall).where(AiCall.job_id == job_id))
        assert call.status == "failed" and call.error_code == "ai_operation_limit"
        assert call.input_tokens == 10 and call.output_tokens == 20
        assert call.cost_usd == Decimal("0.00005")
