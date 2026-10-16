"""Живая приёмка STDIO из запущенного приложения; расходует лимит выбранной подписки."""

import asyncio
import io
import json
import sys
import tempfile
import time
import zipfile
from pathlib import Path

import httpx
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

from app.ai.subscriptions import CodexSession, SubscriptionTransport, claude_run


async def verify_host(config, kind, model):
    """Сам официальный клиент вызывает MCP, без изменения его глобальных настроек."""
    prompt = (
        "Вызови инструменты MCP сервера study-surfers get_status и list_decks. "
        "Не используй другие инструменты и ничего не изменяй. Сообщи статус и количество колод."
    )
    called = set()
    host_events = []
    if kind == "codex":
        async with CodexSession() as server:
            await server.require_subscription()
            saved = (await server.rpc("config/read", {"includeLayers": False}))[
                "config"
            ]
            overrides = {
                f"mcp_servers.{name}.enabled": False
                for name in saved.get("mcp_servers") or {}
            }
            overrides.update(
                {
                    "mcp_servers.study-surfers.command": config["command"],
                    "mcp_servers.study-surfers.args": config["args"],
                    "mcp_servers.study-surfers.enabled": True,
                    "features.shell_tool": False,
                    "features.exec_tool": False,
                    "features.apps": False,
                    "features.plugins": False,
                    "web_search": "disabled",
                }
            )
            thread = await server.rpc(
                "thread/start",
                {
                    "model": model,
                    "cwd": server.folder.name,
                    "approvalPolicy": "never",
                    "sandbox": "read-only",
                    "ephemeral": True,
                    "config": overrides,
                    "baseInstructions": "Проверь только два запрошенных MCP-инструмента.",
                },
            )
            turn = await server.rpc(
                "turn/start",
                {
                    "threadId": thread["thread"]["id"],
                    "effort": "low",
                    "input": [{"type": "text", "text": prompt}],
                },
            )
            async with asyncio.timeout(180):
                while True:
                    event = await server.events.get()
                    data = event.get("params", {})
                    if (
                        "mcp" in event.get("method", "").lower()
                        or event.get("method") == "item/completed"
                    ):
                        item = data.get("item", {})
                        if item.get("type") != "reasoning":
                            host_events.append(
                                {"method": event.get("method"), "params": data}
                            )
                    if event.get("method") == "item/completed":
                        item = data.get("item", {})
                        if (
                            item.get("type") == "mcpToolCall"
                            and item.get("status") == "completed"
                        ):
                            called.add(item["tool"])
                    if (
                        event.get("method") == "turn/completed"
                        and data["turn"]["id"] == turn["turn"]["id"]
                    ):
                        assert data["turn"]["status"] == "completed", data["turn"]
                        break
    else:
        code, stdout, stderr = await claude_run(
            [
                "--restricted",
                "-p",
                "--model",
                model,
                "--effort",
                "low",
                "--output-format",
                "stream-json",
                "--verbose",
                "--tools",
                "",
                "--strict-mcp-config",
                "--mcp-config",
                json.dumps({"mcpServers": {"study-surfers": config}}),
                "--allowedTools",
                "mcp__study-surfers__get_status",
                "mcp__study-surfers__list_decks",
                "--setting-sources",
                "",
                "--no-session-persistence",
            ],
            prompt,
        )
        assert code == 0, stderr
        events = [json.loads(line) for line in stdout.splitlines() if line.strip()]
        result = next(
            event for event in reversed(events) if event.get("type") == "result"
        )
        assert not result.get("is_error"), result
        for event in events:
            for block in event.get("message", {}).get("content", []):
                if isinstance(block, dict) and block.get("type") == "tool_use":
                    called.add(block["name"].removeprefix("mcp__study-surfers__"))
    assert {"get_status", "list_decks"} <= called, {
        "called": sorted(called),
        "events": host_events,
    }
    return sorted(called)


async def verify(config, kind, model, client):
    trace = []
    trace_file = ROOT / f"output/desktop-ai-live/mcp-{kind}-trace.json"
    trace_file.parent.mkdir(parents=True, exist_ok=True)
    async with (
        stdio_client(StdioServerParameters(**config)) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()

        async def call(name, **arguments):
            result = await session.call_tool(name, arguments)
            assert not result.isError, result
            value = result.structuredContent or json.loads(result.content[0].text)
            return (
                value["result"]
                if isinstance(value, dict) and set(value) == {"result"}
                else value
            )

        names = [tool.name for tool in (await session.list_tools()).tools]
        assert len(names) == 8, names
        assert (await call("get_status"))["status"] == "ok"
        assert isinstance(await call("list_decks"), list)
        assert isinstance(await call("list_jobs"), list)
        ids = await call(
            "create_import",
            text="1. Что означает атомарность транзакции?",
            title=f"Живая проверка MCP {kind}",
            items_per_question=1,
        )
        count, cancelled, schema_repairs = 0, False, 0
        async with asyncio.timeout(600):
            while True:
                job = await call("get_job", job_id=ids["job_id"])
                if job["state"] == "done":
                    break
                if job["state"] in {"failed", "interrupted"}:
                    questions = (
                        await client.get(f"/api/decks/{ids['deck_id']}/questions")
                    ).json()
                    raise AssertionError({"job": job, "questions": questions})
                task = (await call("get_next_task", job_id=ids["job_id"]))["task"]
                if not task:
                    await asyncio.sleep(0.3)
                    continue
                assert (await call("get_next_task", job_id=ids["job_id"]))[
                    "task"
                ] is None
                submitted = {k: task[k] for k in ("task_id", "version", "lease_token")}
                if not cancelled:
                    await call("control_job", job_id=ids["job_id"], action="cancel")
                    stale = await call("submit_task_result", **submitted, result={})
                    assert stale["error"] == "mcp_lease_stale", stale
                    await call("control_job", job_id=ids["job_id"], action="resume")
                    cancelled = True
                    continue
                invalid = await call("submit_task_result", **submitted, result={})
                assert invalid.get("error") == "mcp_result_invalid", invalid
                answer = await SubscriptionTransport(kind).complete(
                    model=model,
                    messages=task["messages"],
                    response_schema=task["result_schema"],
                    parameters={"reasoning_effort": "low"},
                )
                submitted.update(
                    result=json.loads(answer.content), model=answer.actual_model_id
                )
                accepted = await call("submit_task_result", **submitted)
                if accepted.get("error") == "mcp_result_invalid":
                    answer = await SubscriptionTransport(kind).complete(
                        model=model,
                        messages=[
                            *task["messages"],
                            {"role": "assistant", "content": answer.content},
                            {
                                "role": "user",
                                "content": "Исправь JSON по исходной схеме: "
                                + json.dumps(accepted["context"], ensure_ascii=False),
                            },
                        ],
                        response_schema=task["result_schema"],
                        parameters={"reasoning_effort": "low"},
                    )
                    submitted.update(
                        result=json.loads(answer.content), model=answer.actual_model_id
                    )
                    accepted = await call("submit_task_result", **submitted)
                    schema_repairs += 1
                trace.append(
                    {
                        "role": task.get("role"),
                        "result": submitted["result"],
                        "reply": accepted,
                    }
                )
                trace_file.write_text(
                    json.dumps(trace, ensure_ascii=False, indent=2), encoding="utf-8"
                )
                assert accepted.get("status") == "accepted", accepted
                repeated = await call("submit_task_result", **submitted)
                assert repeated.get("status") == "already_accepted", repeated
                count += 1
        assert job["ready_items"] >= 1 and not job["failed_questions"], job
        return {
            "state": job["state"],
            "ready_items": job["ready_items"],
            "completed_tasks": count,
            "cancel_resume": cancelled,
            "schema_repairs": schema_repairs,
            "tools": names,
        }


async def main():
    origin, kind, model = sys.argv[1:4]
    async with httpx.AsyncClient(
        base_url=origin, timeout=120, trust_env=False
    ) as client:
        config = (await client.get("/api/settings/ai/mcp")).json()
        config = {k: config[k] for k in ("command", "args")}
        direct = None
        if "--host-only" not in sys.argv:
            started = time.monotonic()
            response = await client.post(
                "/api/imports/quick",
                data={
                    "text": "1. Что означает атомарность транзакции?",
                    "options": json.dumps(
                        {"title": f"Без эталона {kind}", "items_per_question": 1}
                    ),
                },
            )
            response.raise_for_status()
            ids = response.json()
            async with asyncio.timeout(180):
                while True:
                    job = (await client.get(f"/api/jobs/{ids['job_id']}")).json()
                    if job["state"] in {"done", "failed", "interrupted"}:
                        break
                    await asyncio.sleep(0.5)
            assert job["state"] == "done" and job["ready_items"] >= 1, job
            items = (await client.get(f"/api/decks/{ids['deck_id']}/items")).json()[
                "items"
            ]
            assert all(
                item["source"] == "ai_knowledge" and not item["evidence_quote"]
                for item in items
            )
            direct = {
                "state": job["state"],
                "items": len(items),
                "source": "ai_knowledge",
                "seconds": round(time.monotonic() - started, 2),
            }
        result = (
            {}
            if "--host-only" in sys.argv
            else await verify(config, kind, model, client)
        )
        if direct:
            result["app_without_reference"] = direct
        result["official_client_tools"] = await verify_host(config, kind, model)
        # Расширение из настоящего EXE также должно запускаться без системного Python.
        if kind == "codex" and "--host-only" not in sys.argv:
            response = await client.get("/api/settings/ai/mcp/extension")
            response.raise_for_status()
            with tempfile.TemporaryDirectory(prefix="study-surfers-mcpb-") as folder:
                with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                    assert not any(
                        n.endswith((".token", ".sqlite", ".secret"))
                        for n in archive.namelist()
                    )
                    archive.extractall(folder)
                manifest = json.loads(
                    (Path(folder) / "manifest.json").read_text(encoding="utf-8")
                )
                extension = manifest["server"]["mcp_config"]
                executable = extension["command"].replace("${__dirname}", folder)
                async with (
                    stdio_client(
                        StdioServerParameters(
                            command=executable,
                            args=[
                                arg.replace("${__dirname}", folder)
                                for arg in extension["args"]
                            ],
                        )
                    ) as (read, write),
                    ClientSession(read, write) as session,
                ):
                    await session.initialize()
                    status = await session.call_tool("get_status", {})
                    assert json.loads(status.content[0].text)["status"] == "ok"
                result["mcpb_launch"] = manifest["server"]["type"]
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
