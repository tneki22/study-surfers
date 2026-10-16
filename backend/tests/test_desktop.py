import io
import json
import sys
import zipfile
from pathlib import Path

from app import config
from app.mcp_bridge import setup


def test_source_data_stays_in_repository(monkeypatch):
    monkeypatch.delattr(sys, "frozen", raising=False)
    monkeypatch.delenv("SS_DATA_DIR", raising=False)
    assert config.Settings().data_dir == config.ROOT / "data"


def test_frozen_resources_and_data_are_separate(tmp_path, monkeypatch):
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "_MEIPASS", str(tmp_path / "_internal"), raising=False)
    monkeypatch.setenv("LOCALAPPDATA", str(tmp_path / "Local"))
    monkeypatch.delenv("SS_DATA_DIR", raising=False)
    assert config.resource_root() == tmp_path / "_internal"
    assert config.Settings().data_dir == tmp_path / "Local/StudySurfers/data"
    monkeypatch.setenv("SS_DATA_DIR", str(tmp_path / "Путь с пробелами"))
    assert config.Settings().data_dir == tmp_path / "Путь с пробелами"


def test_frozen_mcp_runs_executable_without_python(client, tmp_path, monkeypatch):
    executable = tmp_path / "Приложение/study-surfers-backend.exe"
    executable.parent.mkdir()
    executable.write_bytes(b"native executable")
    internal = executable.parent / "_internal"
    internal.mkdir()
    (internal / "python312.dll").write_bytes(b"bundled interpreter")
    # Соседние файлы пользователя в пакет не попадают.
    (executable.parent / "private.txt").write_text("private", encoding="utf-8")
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    monkeypatch.setattr(sys, "executable", str(executable))
    launch = setup.server_config()
    assert launch["command"] == str(executable)
    assert launch["args"][:2] == ["--mcp", "--token-file"]
    response = client.get("/api/settings/ai/mcp/extension")
    assert response.status_code == 200
    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        assert manifest["server"]["type"] == "binary"
        assert manifest["server"]["entry_point"] in archive.namelist()
        assert manifest["server"]["mcp_config"]["args"][0] == "--mcp"
        assert "backend/_internal/python312.dll" in archive.namelist()
        assert not any(
            Path(name).name in {"private.txt", "mcp.token"} for name in archive.namelist()
        )


def test_custom_port_is_used_for_mcp_and_local_origin(client, monkeypatch):
    monkeypatch.setenv("SS_PORT", "18765")
    config.get_settings.cache_clear()
    response = client.get("/api/settings/ai/mcp", headers={"Origin": "http://127.0.0.1:18765"})
    assert response.status_code == 200
    assert response.json()["args"][-2:] == ["--port", "18765"]
    assert (
        client.get("/api/settings/ai/mcp", headers={"Origin": "http://127.0.0.1:18766"}).status_code
        == 403
    )
