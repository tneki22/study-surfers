import asyncio
import json
import os
from unittest.mock import AsyncMock

import pytest
from test_ai_client import Answer
from test_ai_client import configured as configured
from test_jobs import completion, inject, start, wait_job, wire

from app.ai.client import AiClient
from app.ai.provider import ProviderError, ProviderModel
from app.ai.subscriptions import (
    ClaudeLoginSession,
    CodexSession,
    SubscriptionTransport,
    cli_command,
    subscription_environment,
)
from app.pipeline import jobs


@pytest.fixture
def subscription(client, monkeypatch):
    async def models(self):
        return [
            ProviderModel(
                "subscription-model",
                "Модель по подписке",
                input_modalities=["text"],
                output_modalities=["text"],
            )
        ]

    monkeypatch.setattr(SubscriptionTransport, "list_models", models)
    response = client.post("/api/settings/ai/subscriptions/codex/connect")
    assert response.status_code == 200, response.text
    return response.json()["default_text"]


def test_connect_is_idempotent_and_never_stores_key(subscription, client):
    again = client.post("/api/settings/ai/subscriptions/codex/connect").json()
    assert len(again["providers"]) == 1
    assert len(again["models"]) == 1
    assert again["default_text"] == subscription
    assert again["external_models_enabled"]
    assert again["providers"][0]["executor_kind"] == "codex"
    assert again["providers"][0]["base_url"] == ""
    assert not again["providers"][0]["has_api_key"]
    assert again["models"][0]["prompt_price_usd"] is None


def test_missing_auth_explains_without_creating_connection(client, monkeypatch):
    async def models(self):
        raise ProviderError("ai_subscription_auth_required", "Войдите в ChatGPT")

    monkeypatch.setattr(SubscriptionTransport, "list_models", models)
    response = client.post("/api/settings/ai/subscriptions/codex/connect")
    assert response.status_code == 409
    assert response.json()["code"] == "ai_subscription_auth_required"
    assert not client.get("/api/settings/ai").json()["providers"]


def test_subscription_environment_removes_paid_and_alternative_auth(monkeypatch):
    for key in [
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
        "ANTHROPIC_API_KEY",
        "ANTHROPIC_AUTH_TOKEN",
        "CLAUDE_CODE_OAUTH_TOKEN",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_EFFORT_LEVEL",
        "CLAUDE_CODE_DISABLE_THINKING",
        "CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING",
        "MAX_THINKING_TOKENS",
        "CLAUDECODE",
    ]:
        monkeypatch.setenv(key, "do-not-inherit")
    monkeypatch.setenv("PATH", "keep")
    env = subscription_environment()
    assert env["PATH"] == "keep"
    assert "do-not-inherit" not in env.values()


def test_windows_npm_native_launcher(monkeypatch, tmp_path):
    import app.ai.subscriptions as subscriptions

    binary = tmp_path / "node_modules/@anthropic-ai/claude-code/bin/claude.exe"
    binary.parent.mkdir(parents=True)
    binary.touch()
    monkeypatch.setattr(
        subscriptions.shutil,
        "which",
        lambda name: str(tmp_path / "claude.cmd") if name == "claude" else None,
    )
    monkeypatch.setattr(subscriptions.Path, "home", lambda: tmp_path)
    assert cli_command("claude") == [str(binary)]


@pytest.mark.skipif(os.name != "nt", reason="Windows npm shim")
def test_codex_standalone_cli_takes_priority_over_desktop_bundle(monkeypatch, tmp_path):
    import app.ai.subscriptions as subscriptions

    entry = tmp_path / "node_modules/@openai/codex/bin/codex.js"
    entry.parent.mkdir(parents=True)
    entry.touch()
    commands = {
        "codex.cmd": str(tmp_path / "codex.cmd"),
        "node": str(tmp_path / "node.exe"),
        "codex.exe": str(tmp_path / "desktop/codex.exe"),
    }
    monkeypatch.setattr(subscriptions.shutil, "which", commands.get)
    assert cli_command("codex") == [commands["node"], str(entry)]

    # При неполной npm-установке остаётся рабочий встроенный клиент.
    entry.unlink()
    assert cli_command("codex") == [commands["codex.exe"]]
    entry.touch()
    commands.pop("node")
    assert cli_command("codex") == [commands["codex.exe"]]


def test_subscription_import_without_api_retains_order_and_unknown_cost(
    subscription, client, monkeypatch
):
    from app.ai.provider import FakeTransport

    transport = FakeTransport(
        completions=[
            completion([wire(prompt=f"Какой процесс описан в теме номер {i}?")]) for i in range(3)
        ]
    )
    inject(monkeypatch, transport)
    ids = start(client)
    job = wait_job(client, ids["job_id"])
    assert job["state"] == "done", job
    assert job["ready_items"] == 3
    assert job["usage"]["cost_usd"] is None
    items = client.get(f"/api/decks/{ids['deck_id']}/items").json()["items"]
    assert [i["seq"] for i in items] == [1, 2, 3]
    assert [i["question_ordinal"] for i in items] == [1, 2, 3]
    assert all(c["model"] == "subscription-model" for c in transport.complete_requests)


@pytest.mark.asyncio
async def test_subscription_limit_has_no_retries_and_unknown_cost(subscription, monkeypatch):
    complete = AsyncMock(side_effect=ProviderError("ai_subscription_limit", "Лимит подписки"))
    monkeypatch.setattr(SubscriptionTransport, "complete", complete)
    with pytest.raises(Exception) as error:
        await AiClient(retry_backoff=(0, 0)).complete(
            role="generate", messages=[], response_model=Answer
        )
    assert error.value.code == "ai_subscription_limit"
    assert complete.await_count == 1


def test_subscription_limit_stops_job_and_resume_has_no_duplicates(
    subscription, client, monkeypatch
):
    from app.ai.provider import FakeTransport

    transport = FakeTransport(
        completions=[completion([wire()]), ProviderError("ai_subscription_limit", "Лимит подписки")]
    )
    inject(monkeypatch, transport)
    ids = start(client)
    job = wait_job(client, ids["job_id"])
    assert job["state"] == "failed"
    assert job["error"]["code"] == "ai_subscription_limit"
    assert job["ready_items"] == 1
    transport.completions.extend(
        [completion([wire(prompt=f"Как меняется показатель в условии {i}?")]) for i in range(2)]
    )
    assert client.post(f"/api/jobs/{ids['job_id']}/resume").status_code == 200
    job = wait_job(client, ids["job_id"])
    assert job["state"] == "done", job
    assert job["ready_items"] == 3


def test_job_pins_models_and_prevents_api_extract(subscription, configured, client):
    # Отдельная роль разбора раньше могла ссылаться на API. Подписочный импорт её не вызывает.
    settings = client.get("/api/settings/ai").json()
    api_provider = next(p for p in settings["providers"] if p["executor_kind"] == "api")
    client.put("/api/settings/ai/defaults/text", json={"selection": subscription})
    client.put(
        "/api/settings/ai/roles/extract",
        json={
            "enabled": True,
            "provider_override_id": api_provider["id"],
            "model_override": "test-model",
            "parameters": {},
        },
    )
    snapshot = jobs.snapshot_models()
    assert snapshot["generate"] == subscription
    assert snapshot["extract"] == subscription


@pytest.mark.asyncio
@pytest.mark.parametrize("requested", [None, "off", "low"])
async def test_codex_waits_for_completed_turn_and_checks_failure(requested):
    server = CodexSession()
    server.folder = type("Folder", (), {"name": "/isolated"})()
    server.events = asyncio.Queue()
    server.require_subscription = AsyncMock(return_value={"type": "chatgpt"})
    server.models = AsyncMock(
        return_value=[
            {
                "model": "model",
                "defaultReasoningEffort": "high",
                "supportedReasoningEfforts": [
                    {"reasoningEffort": "low"},
                    {"reasoningEffort": "high"},
                ],
            }
        ]
    )
    server.rpc = AsyncMock(
        side_effect=[{"config": {}}, {"thread": {"id": "thread"}}, {"turn": {"id": "turn"}}]
    )
    for event in [
        {
            "method": "item/completed",
            "params": {
                "threadId": "thread",
                "item": {"type": "agentMessage", "text": '{"answer":"привет"}'},
            },
        },
        {
            "method": "turn/completed",
            "params": {
                "threadId": "thread",
                "turn": {"id": "turn", "status": "failed", "error": {"message": "usage limit"}},
            },
        },
    ]:
        await server.events.put(event)
    with pytest.raises(ProviderError, match="лимит подписки"):
        await server.complete("model", [], {}, {"reasoning_effort": requested})
    thread_args = server.rpc.call_args_list[1].args[1]
    assert thread_args["sandbox"] == "read-only"
    assert thread_args["ephemeral"]
    assert server.rpc.call_args_list[2].args[1]["effort"] == "low"


@pytest.mark.asyncio
@pytest.mark.parametrize("effort", [None, "off", "low", "high"])
async def test_claude_uses_schema_and_no_tools(subscription, monkeypatch, effort):
    import app.ai.subscriptions as subscriptions

    monkeypatch.setattr(
        subscriptions, "claude_account", AsyncMock(return_value={"authMethod": "claude.ai"})
    )
    run = AsyncMock(
        return_value=(
            0,
            json.dumps(
                {
                    "type": "result",
                    "subtype": "success",
                    "structured_output": {"answer": "готово"},
                    "usage": {"input_tokens": 7, "output_tokens": 3},
                    "modelUsage": {"actual-claude": {}},
                }
            ),
            "",
        )
    )
    monkeypatch.setattr(subscriptions, "claude_run", run)
    result = await SubscriptionTransport("claude").complete(
        model="sonnet",
        messages=[],
        response_schema={"type": "object"},
        parameters={"reasoning_effort": effort},
    )
    assert result.content == '{"answer": "готово"}'
    assert result.actual_model_id == "actual-claude"
    assert result.usage.cost_usd is None
    args = run.call_args.args[0]
    assert args[args.index("--tools") + 1] == ""
    assert args[args.index("--mcp-config") + 1] == '{"mcpServers":{}}'
    assert "--restricted" in args
    assert args[args.index("--effort") + 1] == ("high" if effort == "high" else "low")
    if effort == "off":
        assert json.loads(args[args.index("--settings") + 1])["env"] == {
            "CLAUDE_CODE_DISABLE_THINKING": "1"
        }
    else:
        assert "--settings" not in args


@pytest.mark.asyncio
async def test_claude_catalog_uses_installed_client_models(monkeypatch):
    import app.ai.subscriptions as subscriptions

    monkeypatch.setattr(
        subscriptions, "claude_account", AsyncMock(return_value={"authMethod": "claude.ai"})
    )
    monkeypatch.setattr(
        subscriptions,
        "claude_models",
        AsyncMock(
            return_value=[
                {"value": "default", "displayName": "Default"},
                {
                    "value": "future-model",
                    "displayName": "Future",
                    "supportsEffort": True,
                    "supportedEffortLevels": ["low", "high"],
                },
            ]
        ),
    )
    models = await SubscriptionTransport("claude").list_models()
    assert [m.model_id for m in models] == ["future-model"]
    assert models[0].display_name == "Claude Future"
    assert models[0].prompt_price_usd is None
    assert models[0].reasoning["efforts"] == ["low", "high"]


@pytest.mark.asyncio
async def test_claude_login_keeps_stdin_open_and_accepts_browser_code(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock

    import app.ai.subscriptions as subscriptions

    stdout, stderr = asyncio.StreamReader(), asyncio.StreamReader()
    stdout.feed_data(
        b"https://claude.ai/oauth/authorize?state=test\nPaste code here if prompted > "
    )
    stdout.feed_eof()
    stderr.feed_eof()
    stdin = SimpleNamespace(write=Mock(), drain=AsyncMock())
    process = SimpleNamespace(stdout=stdout, stderr=stderr, stdin=stdin, returncode=None)
    launch = AsyncMock(return_value=process)
    monkeypatch.setattr(subscriptions, "spawn", launch)
    monkeypatch.setattr(subscriptions, "stop_process", AsyncMock())
    login = await ClaudeLoginSession().start()
    try:
        assert login.auth_url.startswith("https://claude.ai/oauth/authorize")
        assert login.can_enter_code
        assert not stdin.write.called
        assert launch.call_args.args[:2] == ("claude", ["auth", "login", "--claudeai"])
        await login.submit_code("test-browser-code")
        stdin.write.assert_called_once_with(b"test-browser-code\n")
    finally:
        await login.close()


@pytest.mark.asyncio
async def test_windows_cleanup_waits_for_cli_directory_release():
    from types import SimpleNamespace
    from unittest.mock import Mock

    from app.ai.subscriptions import cleanup_directory

    cleanup = Mock(side_effect=[PermissionError("WinError 32"), None])
    await cleanup_directory(SimpleNamespace(cleanup=cleanup))
    assert cleanup.call_count == 2
