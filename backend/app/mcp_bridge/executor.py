import asyncio
import hashlib
import json

from sqlalchemy import select

from app.ai.provider import ProviderCompletion, ProviderError, ProviderUsage
from app.db import session_factory
from app.mcp_bridge.models import ExternalTask
from app.models import GenerationJob


class ExternalChatExecutor:
    """Сохранённый запрос модели; MCP-вызов получает задание и завершается сразу."""

    def __init__(self, job_id):
        self.job_id = job_id

    async def complete(self, *, messages, response_schema, model, **kwargs):
        payload = {"messages": messages, "schema": response_schema}
        key = hashlib.sha256(
            json.dumps(payload, sort_keys=True, ensure_ascii=False).encode()
        ).hexdigest()
        with session_factory()() as session:
            job = session.get(GenerationJob, self.job_id)
            if not job or job.cancel_requested:
                raise asyncio.CancelledError
            stage = job.state
            task = session.scalar(
                select(ExternalTask).where(
                    ExternalTask.job_id == self.job_id, ExternalTask.request_key == key
                )
            )
            if task is None:
                task = ExternalTask(job_id=self.job_id, request_key=key, payload=payload)
                session.add(task)
            elif task.state == "cancelled":
                task.state, task.lease_token, task.lease_expires_at = "pending", None, None
            session.flush()
            task_id = task.id
            if task.state != "completed":
                job.state = "awaiting_executor"
            session.commit()
        try:
            while True:
                with session_factory()() as session:
                    job = session.get(GenerationJob, self.job_id)
                    task = session.get(ExternalTask, task_id)
                    if not job or job.cancel_requested or not task:
                        raise asyncio.CancelledError
                    if task.state == "completed":
                        if job.state == "awaiting_executor":
                            job.state = stage if stage != "awaiting_executor" else "generating"
                        session.commit()
                        return ProviderCompletion(
                            json.dumps(task.result, ensure_ascii=False),
                            task.actual_model or "external-chat",
                            ProviderUsage(),
                        )
                    if task.state == "cancelled":
                        raise ProviderError(
                            "ai_subscription_unavailable",
                            "Внешнее задание отменено. Генерацию можно продолжить.",
                        )
                await asyncio.sleep(0.25)
        except asyncio.CancelledError:
            with session_factory()() as session:
                task = session.get(ExternalTask, task_id)
                if task and task.state != "completed":
                    task.state = "cancelled"
                    session.commit()
            raise
