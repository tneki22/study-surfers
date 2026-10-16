import sys
from pathlib import Path

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def test_stdio_distinguishes_reading_from_leases_and_writes(tmp_path):
    parameters = StdioServerParameters(
        command=sys.executable,
        args=[
            str(Path(__file__).resolve().parents[1] / "mcp_server.py"),
            "--token-file",
            str(tmp_path / "missing.token"),
        ],
    )
    async with (
        stdio_client(parameters) as (read, write),
        ClientSession(read, write) as session,
    ):
        await session.initialize()
        tools = (await session.list_tools()).tools
        assert {tool.name for tool in tools if tool.annotations.readOnlyHint} == {
            "get_status",
            "list_jobs",
            "get_job",
            "list_decks",
        }
        assert all(tool.annotations.openWorldHint is False for tool in tools)
        assert all(tool.annotations.destructiveHint is False for tool in tools)
        submit = next(tool for tool in tools if tool.name == "submit_task_result")
        assert submit.annotations.idempotentHint is True
