"""Изолированное чтение SQLite Tentex; источник никогда не открывается на запись."""

import json
import re
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from uuid import UUID

from cryptography.fernet import Fernet, InvalidToken

from app.config import get_settings
from app.core.errors import DomainError

IMAGE_MARKER_RE = re.compile(r"\[изображение:\s*[^\]]*\]", re.IGNORECASE)


def public_id(raw: str) -> str:
    try:
        return str(UUID(str(raw)))
    except ValueError as exc:
        raise DomainError(
            422, "tentex_database_invalid", "В базе Tentex найден неверный идентификатор"
        ) from exc


def clean_answer(text: str | None) -> str:
    return IMAGE_MARKER_RE.sub("", text or "").strip()


def json_value(raw, fallback):
    if raw is None:
        return fallback
    if isinstance(raw, str):
        try:
            return json.loads(raw)
        except ValueError:
            return fallback
    return raw


class TentexReader:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root is not None else get_settings().tentex_root
        self.path = self.root / "data" / "tentex.sqlite"
        self.secret_path = self.root / "data" / "installation.secret"

    @property
    def running(self) -> bool:
        wal = self.path.with_name(self.path.name + "-wal")
        return wal.is_file() and wal.stat().st_size > 0

    @contextmanager
    def connect(self, *, force: bool = False):
        if not self.path.is_file():
            raise DomainError(
                404, "tentex_not_found", "База Tentex не найдена", {"root": str(self.root)}
            )
        running = self.running
        if running and not force:
            raise DomainError(
                409,
                "tentex_running",
                "Tentex сейчас работает. Закройте его перед импортом или явно разрешите чтение работающей базы",
            )
        uri = self.path.resolve().as_uri() + "?mode=ro" + ("" if running else "&immutable=1")
        connection = None
        try:
            connection = sqlite3.connect(uri, uri=True, timeout=5)
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA query_only=ON")
            yield connection
        except sqlite3.DatabaseError as exc:
            raise DomainError(
                422, "tentex_database_invalid", "Не удалось прочитать структуру базы Tentex"
            ) from exc
        finally:
            if connection is not None:
                connection.close()

    @staticmethod
    def table_exists(connection, table: str) -> bool:
        return (
            connection.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)
            ).fetchone()
            is not None
        )

    def decrypt_key(self, ciphertext) -> str:
        explicit = get_settings().tentex_secret_key
        if explicit:
            key = explicit.encode()
        elif self.secret_path.is_file():
            key = self.secret_path.read_bytes().strip()
        else:
            raise DomainError(409, "tentex_secret_missing", "Ключ шифрования Tentex не найден")
        try:
            data = ciphertext.encode() if isinstance(ciphertext, str) else bytes(ciphertext)
            return Fernet(key).decrypt(data).decode()
        except (InvalidToken, ValueError, UnicodeError, TypeError) as exc:
            raise DomainError(
                409, "tentex_secret_mismatch", "Ключ не подходит для расшифровки провайдера Tentex"
            ) from exc

    def status(self) -> dict:
        found = self.path.is_file()
        count = 0
        if found and not self.running:
            with self.connect() as connection:
                count = connection.execute(
                    "SELECT count(*) FROM projects WHERE workspace_variant='exam' AND status!='draft'"
                ).fetchone()[0]
        return {
            "root": str(self.root),
            "db_found": found,
            "secret_found": bool(get_settings().tentex_secret_key) or self.secret_path.is_file(),
            "running": self.running,
            "projects_count": count,
        }

    def projects(self, *, force: bool = False) -> list[dict]:
        with self.connect(force=force) as connection:
            rows = connection.execute(
                "SELECT id,name,status,updated_at FROM projects WHERE workspace_variant='exam' AND status!='draft' ORDER BY updated_at DESC,id"
            ).fetchall()
            output = []
            for row in rows:
                project = dict(row)
                raw_id = row["id"]
                project["id"] = public_id(raw_id)
                project["name"] = project["name"] or "Проект Tentex"
                project["question_count"] = connection.execute(
                    "SELECT count(*) FROM program_nodes WHERE project_id=? AND node_type='topic' AND is_archived=0 AND is_in_current_program=1",
                    (raw_id,),
                ).fetchone()[0]
                project["answer_count"] = (
                    connection.execute(
                        "SELECT count(*) FROM reference_answers r JOIN program_nodes n ON n.id=r.program_node_id WHERE r.project_id=? AND r.is_active=1 AND n.is_archived=0 AND n.is_in_current_program=1",
                        (raw_id,),
                    ).fetchone()[0]
                    if self.table_exists(connection, "reference_answers")
                    else 0
                )
                project["card_count"] = (
                    connection.execute(
                        "SELECT count(*) FROM cards c JOIN activities a ON a.id=c.activity_id LEFT JOIN program_nodes n ON n.id=a.program_node_id WHERE c.project_id=? AND c.deleted_at IS NULL AND c.state='active' AND (a.program_node_id IS NULL OR (n.is_archived=0 AND n.is_in_current_program=1))",
                        (raw_id,),
                    ).fetchone()[0]
                    if self.table_exists(connection, "cards")
                    else 0
                )
                output.append(project)
            return output

    def project(self, project_id: str, *, force: bool = False) -> dict:
        try:
            raw_id = UUID(project_id).hex
        except ValueError as exc:
            raise DomainError(404, "tentex_project_not_found", "Проект Tentex не найден") from exc
        with self.connect(force=force) as connection:
            project = connection.execute(
                "SELECT * FROM projects WHERE id=? AND workspace_variant='exam' AND status!='draft'",
                (raw_id,),
            ).fetchone()
            if project is None:
                raise DomainError(404, "tentex_project_not_found", "Проект Tentex не найден")
            nodes = [
                dict(row)
                for row in connection.execute(
                    "SELECT * FROM program_nodes WHERE project_id=? AND is_archived=0 AND is_in_current_program=1 ORDER BY sort_order,id",
                    (raw_id,),
                )
            ]
            answers = (
                [
                    dict(row)
                    for row in connection.execute(
                        "SELECT * FROM reference_answers WHERE project_id=? AND is_active=1",
                        (raw_id,),
                    )
                ]
                if self.table_exists(connection, "reference_answers")
                else []
            )
            cards = (
                [
                    dict(row)
                    for row in connection.execute(
                        "SELECT c.*,a.program_node_id FROM cards c JOIN activities a ON a.id=c.activity_id WHERE c.project_id=? AND c.deleted_at IS NULL AND c.state='active' ORDER BY c.id",
                        (raw_id,),
                    )
                ]
                if self.table_exists(connection, "cards")
                else []
            )
            return {"project": dict(project), "nodes": nodes, "answers": answers, "cards": cards}

    def providers(self, *, force: bool = False) -> dict:
        with self.connect(force=force) as connection:
            providers = (
                [dict(row) for row in connection.execute("SELECT * FROM ai_provider_connections")]
                if self.table_exists(connection, "ai_provider_connections")
                else []
            )
            models = (
                [dict(row) for row in connection.execute("SELECT * FROM ai_model_catalog")]
                if self.table_exists(connection, "ai_model_catalog")
                else []
            )
            settings = (
                connection.execute("SELECT * FROM ai_settings WHERE id=1").fetchone()
                if self.table_exists(connection, "ai_settings")
                else None
            )
            return {
                "providers": providers,
                "models": models,
                "settings": dict(settings) if settings else {},
            }
