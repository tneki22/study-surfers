import asyncio
import io
import json
import sys
import zipfile
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, Response
from pydantic import BaseModel

from app import __version__
from app.ai.subscriptions import cli_command, spawn, stop_process, temporary_workspace
from app.config import ROOT, get_settings
from app.core.errors import DomainError
from app.mcp_bridge.security import check_local_origin, local_token, token_file

router = APIRouter(
    prefix="/api/settings/ai/mcp", tags=["ai-settings"], dependencies=[Depends(check_local_origin)]
)


def server_config():
    return {
        "command": sys.executable,
        "args": [
            "--mcp" if getattr(sys, "frozen", False) else str(ROOT / "backend/mcp_server.py"),
            "--token-file",
            str(token_file().resolve()),
            *(["--port", str(get_settings().port)] if get_settings().port != 8765 else []),
        ],
    }


class McpSetupRead(BaseModel):
    name: str = "study-surfers"
    command: str
    args: list[str]
    instructions: str = "Для обычной генерации из программы MCP устанавливать не нужно. Это дополнительное подключение для работы из чата."


class McpInstallRead(BaseModel):
    status: Literal["installed", "already_installed"]
    detail: str


@router.get("", response_model=McpSetupRead)
def get_mcp_setup():
    local_token()
    return McpSetupRead(**server_config())


async def run_cli(kind, args):
    async with temporary_workspace(prefix="study-surfers-setup-") as folder:
        process = await spawn(kind, args, folder)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), 30)
            return (
                process.returncode,
                stdout.decode("utf-8", errors="replace"),
                stderr.decode("utf-8", errors="replace"),
            )
        finally:
            await stop_process(process)


@router.post("/install/{client}", response_model=McpInstallRead)
async def install_mcp(client: Literal["codex", "claude"]):
    local_token()
    try:
        cli_command(client)
        config = server_config()
        # Официальная команда затрагивает только именованное подключение.
        code, output, _ = await run_cli(
            client, ["mcp", "get", "study-surfers", *(["--json"] if client == "codex" else [])]
        )
        if code == 0:
            if client == "codex":
                try:
                    saved = json.loads(output)
                    transport = saved.get("transport", saved)
                    matches = (
                        transport.get("command") == config["command"]
                        and transport.get("args") == config["args"]
                    )
                except (ValueError, AttributeError):
                    matches = False
            else:
                matches = all(value in output for value in [config["command"], *config["args"]])
            # Чужую запись с таким же именем никогда не перезаписываем.
            if not matches:
                raise DomainError(
                    409,
                    "mcp_name_conflict",
                    "Подключение study-surfers уже существует с другой командой. Удалите или переименуйте его в настройках клиента, затем повторите установку",
                )
            return McpInstallRead(
                status="already_installed",
                detail="MCP уже добавлен. Перезапустите клиент или начните новый чат, чтобы он увидел инструменты Study Surfers.",
            )
        arguments = ["mcp", "add"]
        if client == "claude":
            arguments += ["--scope", "user", "--transport", "stdio"]
        arguments += ["study-surfers", "--", config["command"], *config["args"]]
        code, _, _ = await run_cli(client, arguments)
        if code:
            raise DomainError(
                409,
                "mcp_install_failed",
                "Клиент не добавил MCP. Проверьте, что установлен актуальный официальный клиент, и повторите установку",
            )
        return McpInstallRead(
            status="installed",
            detail="Study Surfers добавлен в MCP клиента. Перезапустите клиент или начните новый чат и оставьте Study Surfers запущенным.",
        )
    except (OSError, TimeoutError) as error:
        raise DomainError(
            409,
            "mcp_install_failed",
            "Не удалось запустить настройку MCP. Обновите клиент и попробуйте снова",
        ) from error
    except Exception as error:
        from app.ai.provider import ProviderError

        if isinstance(error, ProviderError):
            raise DomainError(409, error.code, error.detail) from error
        raise


@router.get("/extension")
def download_desktop_extension():
    """Пакет для этой локальной установки: без токена внутри и без второго сервера БД."""
    local_token()
    config = server_config()
    manifest = {
        "manifest_version": "0.3",
        "name": "study-surfers",
        "version": __version__,
        "display_name": "Study Surfers",
        "description": "Генерация карточек из учебных материалов в локальном Study Surfers",
        "author": {"name": "Study Surfers"},
        "server": {
            "type": "python",
            "entry_point": "server.py",
            "mcp_config": {
                "command": config["command"],
                "args": ["${__dirname}/server.py", *config["args"][1:]],
            },
        },
        "compatibility": {"platforms": [sys.platform]},
    }
    buffer = io.BytesIO()
    frozen = getattr(sys, "frozen", False)
    if frozen:
        # Нативный пакет содержит свой интерпретатор. Python у пользователя не нужен.
        manifest["server"] = {
            "type": "binary",
            "entry_point": "backend/" + Path(sys.executable).name,
            "mcp_config": {
                "command": "${__dirname}/backend/" + Path(sys.executable).name,
                "args": config["args"],
            },
        }
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
        if frozen:
            executable = Path(sys.executable)
            archive.write(executable, "backend/" + executable.name)
            for file in sorted((executable.parent / "_internal").rglob("*")):
                if file.is_file():
                    archive.write(file, "backend/" + file.relative_to(executable.parent).as_posix())
        else:
            archive.writestr("server.py", (ROOT / "backend/mcp_server.py").read_bytes())
    return Response(
        buffer.getvalue(),
        media_type="application/octet-stream",
        headers={"Content-Disposition": 'attachment; filename="Study-Surfers.mcpb"'},
    )
