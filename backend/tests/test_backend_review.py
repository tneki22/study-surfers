import base64
import sqlite3
import subprocess
from pathlib import Path

import pytest

from app import db
from app.config import ROOT, get_settings


@pytest.fixture
def fresh_database(tmp_path, monkeypatch):
    monkeypatch.setenv("SS_DATA_DIR", str(tmp_path))
    get_settings.cache_clear()
    db.get_engine.cache_clear()
    try:
        yield tmp_path
    finally:
        db.get_engine().dispose()
        db.get_engine.cache_clear()
        get_settings.cache_clear()


def test_failed_migration_rolls_back_ddl_and_schema_version(fresh_database, monkeypatch):
    def broken(connection):
        connection.exec_driver_sql("CREATE TABLE partial_migration (id INTEGER)")
        connection.exec_driver_sql("PRAGMA user_version=1")
        raise RuntimeError("Прерванный шаг миграции")

    monkeypatch.setattr(db, "MIGRATIONS", [broken])
    monkeypatch.setattr(db, "SCHEMA_VERSION", 1)
    with pytest.raises(RuntimeError, match="Прерванный"):
        db.init_db()
    with db.get_engine().connect() as connection:
        assert connection.exec_driver_sql("PRAGMA user_version").scalar_one() == 0
        assert (
            connection.exec_driver_sql(
                "SELECT name FROM sqlite_master WHERE name='partial_migration'"
            ).scalar()
            is None
        )
    backups = list((fresh_database / "backups").glob("*.sqlite"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as backup:
        assert backup.execute("PRAGMA user_version").fetchone()[0] == 0


def test_each_migration_backup_matches_preceding_schema_version(fresh_database, monkeypatch):
    def first(connection):
        connection.exec_driver_sql("CREATE TABLE migration_marker (id INTEGER)")
        connection.exec_driver_sql("INSERT INTO migration_marker VALUES (1)")

    def second(connection):
        connection.exec_driver_sql("INSERT INTO migration_marker VALUES (2)")

    monkeypatch.setattr(db, "MIGRATIONS", [first, second])
    monkeypatch.setattr(db, "SCHEMA_VERSION", 2)
    db.init_db()
    versions = []
    backups = list((fresh_database / "backups").glob("*.sqlite"))
    assert len(backups) == 2
    for path in backups:
        with sqlite3.connect(path) as backup:
            version = backup.execute("PRAGMA user_version").fetchone()[0]
            versions.append(version)
            assert path.name.startswith(f"schema-{version}-")
            if version == 1:
                assert backup.execute("SELECT id FROM migration_marker").fetchall() == [(1,)]
    assert sorted(versions) == [0, 1]
    with db.get_engine().connect() as connection:
        assert connection.exec_driver_sql("PRAGMA user_version").scalar_one() == 2
        assert connection.exec_driver_sql("SELECT id FROM migration_marker").all() == [(1,), (2,)]
    db.init_db()
    assert len(list((fresh_database / "backups").glob("*.sqlite"))) == 2


@pytest.mark.skipif(__import__("os").name != "nt", reason="Проверка Windows PowerShell 5.1")
def test_launcher_russian_source_is_decoded_by_windows_powershell():
    launcher = str(ROOT / "scripts" / "launcher.ps1").replace("'", "''")
    script = f"""
$parseTokens = $null
$parseErrors = $null
$tree = [System.Management.Automation.Language.Parser]::ParseFile('{launcher}', [ref]$parseTokens, [ref]$parseErrors)
if ($parseErrors.Count -gt 0) {{ exit 2 }}
$strings = $tree.FindAll({{ param($node) $node -is [System.Management.Automation.Language.ExpandableStringExpressionAst] }}, $true)
if (-not ($strings | Where-Object {{ $_.Value.Contains('Не удалось запустить Study Surfers:') }})) {{ exit 3 }}
"""
    encoded = base64.b64encode(script.encode("utf-16-le")).decode("ascii")
    powershell = (
        Path(__import__("os").environ["SystemRoot"])
        / "System32/WindowsPowerShell/v1.0/powershell.exe"
    )
    result = subprocess.run(
        [str(powershell), "-NoProfile", "-EncodedCommand", encoded], capture_output=True, timeout=20
    )
    assert result.returncode == 0, (
        "PowerShell 5.1 должен читать русский текст лаунчера без искажений"
    )
