import io
import json
import time
import zipfile
from datetime import UTC, datetime, timedelta
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select
from test_jobs import wait_job, wire

from app.db import session_factory
from app.mcp_bridge.models import ExternalTask
from app.mcp_bridge.security import local_token
from app.models import GenerationJob
from app.pipeline.jobs import recover_jobs


@pytest.fixture
def auth(client):
    return {"Authorization": f"Bearer {local_token()}"}


def start_chat(client, auth, **options):
    response = client.post(
        "/api/mcp/imports",
        json={
            "text": "1. Работа и энергия\n2. Законы сохранения\n3. Тепловые процессы",
            "title": "Физика",
            "items_per_question": 1,
            **options,
        },
        headers=auth,
    )
    assert response.status_code == 202, response.text
    return response.json()


def next_task(client, auth, job_id, timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        response = client.post("/api/mcp/tasks/next", params={"job_id": job_id}, headers=auth)
        assert response.status_code == 200, response.text
        task = response.json()["task"]
        if task:
            return task
        time.sleep(0.03)
    pytest.fail("Не появилось задание MCP")


def submit(client, auth, task, result):
    return client.post(
        "/api/mcp/tasks/submit",
        json={
            "task_id": task["task_id"],
            "version": task["version"],
            "lease_token": task["lease_token"],
            "result": result,
            "model": "test-chat",
        },
        headers=auth,
    )


def card_result(index=0):
    return {
        "items": [wire(prompt=f"Какая величина определяется для случая {index}?")],
        "skipped_reason": "",
    }


def test_new_endpoints_need_local_token_and_reject_foreign_origin(client, auth):
    assert client.get("/api/mcp/jobs").status_code == 401
    assert client.get("/api/mcp/jobs", headers=auth).status_code == 200
    assert (
        client.get("/api/mcp/jobs", headers=auth | {"Origin": "https://other.example"}).status_code
        == 403
    )


def test_empty_token_file_never_authorizes(client):
    from app.mcp_bridge.security import token_file

    token_file().write_text("", encoding="utf-8")
    assert client.get("/api/mcp/jobs").status_code == 401


def test_new_login_and_install_endpoints_reject_external_pages(client):
    for path in [
        "/api/settings/ai/subscriptions/codex/login",
        "/api/settings/ai/mcp/install/codex",
    ]:
        response = client.post(path, headers={"Origin": "https://other.example"})
        assert response.status_code == 403


def test_chat_import_needs_no_cli_or_api_and_uses_common_writer(client, auth, monkeypatch):
    from app.ai.subscriptions import SubscriptionTransport

    monkeypatch.setattr(
        SubscriptionTransport,
        "complete",
        AsyncMock(side_effect=AssertionError("Не вызывать локальный клиент")),
    )
    ids = start_chat(client, auth)
    for i in range(3):
        task = next_task(client, auth, ids["job_id"])
        assert task["result_schema"]["type"] == "object"
        assert "Материалы" in task["instructions"] or "материалы" in task["instructions"]
        assert submit(client, auth, task, card_result(i)).status_code == 200
    job = wait_job(client, ids["job_id"])
    assert job["state"] == "done", job
    assert job["ready_items"] == 3
    assert job["usage"]["cost_usd"] is None
    items = client.get(f"/api/decks/{ids['deck_id']}/items").json()["items"]
    assert [i["question_ordinal"] for i in items] == [1, 2, 3]
    assert [i["seq"] for i in items] == [1, 2, 3]
    settings = client.get("/api/settings/ai").json()
    assert settings["providers"] == []
    assert settings["models"] == []


def test_lease_is_exclusive_results_idempotent_and_schema_repairable(client, auth):
    ids = start_chat(client, auth)
    task = next_task(client, auth, ids["job_id"])
    other = client.post(
        "/api/mcp/tasks/next", params={"job_id": ids["job_id"]}, headers=auth
    ).json()
    assert other["task"] is None
    invalid = submit(client, auth, task, {"bad": True})
    assert invalid.status_code == 422
    assert invalid.json()["code"] == "mcp_result_invalid"
    result = card_result()
    assert submit(client, auth, task, result).json()["status"] == "accepted"
    assert submit(client, auth, task, result).json()["status"] == "already_accepted"
    assert submit(client, auth, task, card_result(8)).json()["code"] == "mcp_result_conflict"


def test_expired_lease_cannot_apply_result(client, auth):
    ids = start_chat(client, auth)
    task = next_task(client, auth, ids["job_id"])
    with session_factory()() as session:
        session.get(ExternalTask, task["task_id"]).lease_expires_at = datetime.now(UTC) - timedelta(
            seconds=1
        )
        session.commit()
    assert submit(client, auth, task, card_result()).status_code == 409
    fresh = next_task(client, auth, ids["job_id"])
    assert fresh["version"] == task["version"] + 1
    assert fresh["lease_token"] != task["lease_token"]
    assert submit(client, auth, task, card_result()).status_code == 409


def test_cancel_waiting_job_rejects_old_result_and_resume_preserves_completed(client, auth):
    ids = start_chat(client, auth)
    first = next_task(client, auth, ids["job_id"])
    assert submit(client, auth, first, card_result()).status_code == 200
    second = next_task(client, auth, ids["job_id"])
    assert client.post(f"/api/jobs/{ids['job_id']}/cancel").status_code == 200
    assert submit(client, auth, second, card_result(1)).status_code == 409
    assert client.post(f"/api/jobs/{ids['job_id']}/resume").status_code == 200
    for i in [1, 2]:
        current = next_task(client, auth, ids["job_id"])
        assert submit(client, auth, current, card_result(i)).status_code == 200
    job = wait_job(client, ids["job_id"])
    assert job["state"] == "done"
    assert job["ready_items"] == 3


def test_restart_preserves_completed_tasks_and_interrupts_waiting(client, auth):
    ids = start_chat(client, auth)
    first = next_task(client, auth, ids["job_id"])
    assert submit(client, auth, first, card_result()).status_code == 200
    next_task(client, auth, ids["job_id"])
    # Закрытие владельца задач — как при штатном перезапуске приложения.
    from app.pipeline.jobs import get_manager

    client.portal.call(lambda: get_manager().close())
    recover_jobs()
    with session_factory()() as session:
        assert session.get(GenerationJob, ids["job_id"]).state == "interrupted"
        assert (
            session.scalar(select(ExternalTask).where(ExternalTask.id == first["task_id"])).state
            == "completed"
        )


def test_desktop_extension_is_local_and_contains_no_token(client, auth):
    response = client.get("/api/settings/ai/mcp/extension")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["manifest_version"] == "0.3"
        assert "--token-file" in manifest["server"]["mcp_config"]["args"]
        assert local_token() not in archive.read("manifest.json").decode()
        assert "app.db" not in archive.read("server.py").decode()


@pytest.mark.asyncio
async def test_install_is_idempotent_even_with_cli_stderr_warnings(client, monkeypatch):
    from app.mcp_bridge import setup

    config = setup.server_config()
    run = AsyncMock(
        side_effect=[
            (1, "", "not found"),
            (0, "added", "warning"),
            (0, json.dumps({"transport": {"type": "stdio", **config}}), "warning"),
        ]
    )
    monkeypatch.setattr(setup, "run_cli", run)
    monkeypatch.setattr(setup, "cli_command", lambda _: ["codex"])
    assert (await setup.install_mcp("codex")).status == "installed"
    assert (await setup.install_mcp("codex")).status == "already_installed"
    assert run.await_count == 3


@pytest.mark.asyncio
async def test_stdio_server_advertises_tools_without_starting_database(tmp_path):
    import sys
    from pathlib import Path

    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    parameters = StdioServerParameters(
        command=sys.executable,
        args=[
            str(Path(__file__).resolve().parents[1] / "mcp_server.py"),
            "--token-file",
            str(tmp_path / "mcp.token"),
        ],
    )
    async with stdio_client(parameters) as (read, write):
        async with ClientSession(read, write) as session:
            initialized = await session.initialize()
            assert initialized.serverInfo.name == "Study Surfers"
            tools = await session.list_tools()
            assert {t.name for t in tools.tools} == {
                "get_status",
                "list_jobs",
                "get_next_task",
                "submit_task_result",
                "get_job",
                "control_job",
                "list_decks",
                "create_import",
            }
            result = await session.call_tool("get_status", {})
            assert "app_not_running" in str(result)
    assert not list(tmp_path.glob("*.sqlite"))
