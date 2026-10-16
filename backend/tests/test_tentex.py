import asyncio
import json
import sqlite3
from contextlib import closing
from uuid import uuid4

import pytest
from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import select

from app.ai.credentials import decrypt_secret
from app.ai.models import AiModelCatalogEntry, AiProviderConnection, AiSettings
from app.config import get_settings
from app.core.errors import DomainError
from app.db import session_factory
from app.models import GenerationJob, Question, QuizItem
from app.tentex.reader import TentexReader
from app.tentex.schemas import TentexProjectImport, TentexProvidersImport
from app.tentex.service import import_project, import_providers, list_providers


@pytest.fixture
def tentex(tmp_path, monkeypatch, client):
    root = tmp_path / "tentex"
    folder = root / "data"
    folder.mkdir(parents=True)
    path = folder / "tentex.sqlite"
    ids = {
        name: uuid4()
        for name in [
            "project",
            "draft",
            "course",
            "section",
            "ticket",
            "topic",
            "subpoint",
            "second",
            "archived",
            "inactive",
            "card",
            "other_card",
            "archived_card",
            "activity",
            "other_activity",
            "archived_activity",
            "provider",
            "local",
        ]
    }
    key = Fernet.generate_key()
    (folder / "installation.secret").write_bytes(key)
    with closing(sqlite3.connect(path)) as db, db:
        db.executescript("""
            CREATE TABLE projects(id CHAR(32) PRIMARY KEY,name TEXT,description TEXT,status TEXT,workspace_variant TEXT,updated_at TEXT);
            CREATE TABLE program_nodes(id CHAR(32) PRIMARY KEY,project_id CHAR(32),parent_id CHAR(32),node_type TEXT,exam_kind TEXT,sort_order INTEGER,title TEXT,is_archived INTEGER,is_in_current_program INTEGER);
            CREATE TABLE reference_answers(project_id CHAR(32),program_node_id CHAR(32),text TEXT,is_active INTEGER);
            CREATE TABLE activities(id CHAR(32) PRIMARY KEY,project_id CHAR(32),program_node_id CHAR(32));
            CREATE TABLE cards(id CHAR(32) PRIMARY KEY,project_id CHAR(32),activity_id CHAR(32),front TEXT,back TEXT,state TEXT,deleted_at TEXT);
            CREATE TABLE ai_provider_connections(id CHAR(32) PRIMARY KEY,label TEXT,base_url TEXT,catalog_profile TEXT,api_key_ciphertext BLOB,is_favorite INTEGER);
            CREATE TABLE ai_model_catalog(provider_id CHAR(32),model_id TEXT,display_name TEXT,input_modalities TEXT,output_modalities TEXT,supported_parameters TEXT,prompt_price_usd TEXT,completion_price_usd TEXT,is_available INTEGER);
            CREATE TABLE ai_settings(id INTEGER PRIMARY KEY,default_text_provider_id CHAR(32),default_text_model_id TEXT);
        """)
        for name, variant, status in [
            ("project", "exam", "active"),
            ("draft", "exam", "draft"),
            ("course", "course", "active"),
        ]:
            db.execute(
                "INSERT INTO projects VALUES(?,?,?,?,?,?)",
                (
                    ids[name].hex,
                    "Подготовка к экзамену",
                    "Описание проекта",
                    status,
                    variant,
                    "2026-10-01T12:00:00+00:00",
                ),
            )
        nodes = [
            ("section", None, "section", None, 0, "Базы данных", 0, 1),
            ("ticket", "section", "section", "ticket", 0, "Билет 1", 0, 1),
            ("topic", "ticket", "topic", "question", 0, "Транзакции", 0, 1),
            ("subpoint", "topic", "subpoint", "question", 0, "Атомарность", 0, 1),
            ("second", "section", "topic", "question", 1, "Индексы", 0, 1),
            ("archived", "section", "topic", "question", 2, "Архивный вопрос", 1, 1),
            ("inactive", "section", "topic", "question", 3, "Исключённый вопрос", 0, 0),
        ]
        for name, parent, kind, exam, order, title, archived, current in nodes:
            db.execute(
                "INSERT INTO program_nodes VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    ids[name].hex,
                    ids["project"].hex,
                    ids[parent].hex if parent else None,
                    kind,
                    exam,
                    order,
                    title,
                    archived,
                    current,
                ),
            )
        marker = f"[изображение: Схема · стр. 2 · {uuid4()}]"
        for node, text, active in [
            ("topic", f"Транзакция выполняется целиком. {marker}", 1),
            ("subpoint", "Атомарность запрещает частичный результат.", 1),
            ("second", "Индекс ускоряет поиск.", 1),
            ("archived", "Скрытый ответ.", 1),
            ("inactive", "Скрытый ответ.", 1),
            ("second", "Старый ответ.", 0),
        ]:
            db.execute(
                "INSERT INTO reference_answers VALUES(?,?,?,?)",
                (ids["project"].hex, ids[node].hex, text, active),
            )
        for activity, node in [
            ("activity", "subpoint"),
            ("other_activity", None),
            ("archived_activity", "archived"),
        ]:
            db.execute(
                "INSERT INTO activities VALUES(?,?,?)",
                (ids[activity].hex, ids["project"].hex, ids[node].hex if node else None),
            )
        for card, activity, front, back in [
            ("card", "activity", "Свойство транзакции?", "Атомарность"),
            ("other_card", "other_activity", "Что ускоряет поиск?", "Индекс"),
            ("archived_card", "archived_activity", "Архивная карточка", "Архив"),
        ]:
            db.execute(
                "INSERT INTO cards VALUES(?,?,?,?,?,?,?)",
                (ids[card].hex, ids["project"].hex, ids[activity].hex, front, back, "active", None),
            )
        db.execute(
            "INSERT INTO ai_provider_connections VALUES(?,?,?,?,?,?)",
            (
                ids["provider"].hex,
                "Облачный провайдер",
                "https://example.com/v1",
                "openai_compatible",
                Fernet(key).encrypt(b"tentex-test-secret"),
                1,
            ),
        )
        db.execute(
            "INSERT INTO ai_provider_connections VALUES(?,?,?,?,?,?)",
            (
                ids["local"].hex,
                "Локальная модель",
                "http://host.docker.internal:1234/v1",
                "openai_compatible",
                None,
                0,
            ),
        )
        for provider in ["provider", "local"]:
            db.execute(
                "INSERT INTO ai_model_catalog VALUES(?,?,?,?,?,?,?,?,?)",
                (
                    ids[provider].hex,
                    "test-model",
                    "Тестовая модель",
                    json.dumps(["text"]),
                    json.dumps(["text"]),
                    json.dumps(["temperature"]),
                    "0.000001",
                    "0.000002",
                    1,
                ),
            )
        db.execute("INSERT INTO ai_settings VALUES(?,?,?)", (1, ids["local"].hex, "test-model"))
    monkeypatch.setenv("SS_TENTEX_ROOT", str(root))
    get_settings.cache_clear()
    return root, path, ids, key


def test_projects_counters_ids_and_read_only_source(tentex):
    root, path, ids, _ = tentex
    before = (path.stat().st_size, path.stat().st_mtime_ns, path.read_bytes())
    reader = TentexReader(root)
    status = reader.status()
    assert status["projects_count"] == 1
    assert status["db_found"] and status["secret_found"] and not status["running"]
    projects = reader.projects()
    assert len(projects) == 1
    assert projects[0]["id"] == str(ids["project"])
    assert (
        projects[0]["question_count"],
        projects[0]["answer_count"],
        projects[0]["card_count"],
    ) == (2, 3, 2)
    assert reader.project(str(ids["project"]))["project"]["id"] == ids["project"].hex
    with reader.connect() as db:
        with pytest.raises(sqlite3.OperationalError):
            db.execute("DELETE FROM projects")
    assert (path.stat().st_size, path.stat().st_mtime_ns, path.read_bytes()) == before
    assert not path.with_name(path.name + "-wal").exists()
    assert not path.with_name(path.name + "-shm").exists()


def test_wal_guard_status_and_force(tentex):
    root, path, ids, _ = tentex
    with closing(sqlite3.connect(path)) as writer, writer:
        writer.execute("PRAGMA journal_mode=WAL")
        writer.execute(
            "UPDATE projects SET name='Название после WAL' WHERE id=?", (ids["project"].hex,)
        )
        writer.commit()
        reader = TentexReader(root)
        assert reader.status()["running"]
        assert reader.status()["projects_count"] == 0
        with pytest.raises(DomainError) as error:
            reader.projects()
        assert error.value.code == "tentex_running"
        assert reader.projects(force=True)[0]["name"] == "Название после WAL"


def test_project_import_dfs_subpoints_and_existing_cards(tentex):
    _root, _path, ids, _ = tentex
    with session_factory()() as session:
        deck, job = import_project(session, str(ids["project"]), TentexProjectImport())
        questions = list(
            session.scalars(
                select(Question).where(Question.deck_id == deck.id).order_by(Question.ordinal)
            )
        )
        assert deck.source_kind == "tentex" and deck.tentex_project_id == str(ids["project"])
        assert job.kind == "tentex_import" and job.total == 3
        assert questions[0].section == "Билет 1"
        assert questions[0].text == "Транзакции\n• Атомарность"
        assert (
            "### Атомарность\nАтомарность запрещает частичный результат."
            in questions[0].answer_text
        )
        assert "[изображение:" not in questions[0].answer_text
        assert questions[1].section == "Базы данных"
        assert questions[2].synthetic and questions[2].text == "Что ускоряет поиск?"
        assert deck.options["tentex_cards"][questions[0].id][0]["tentex_card_id"] == str(
            ids["card"]
        )
        assert len(deck.options["tentex_cards"]) == 2
        assert session.get(GenerationJob, job.id) is not None


def test_project_import_flags(tentex):
    _root, _path, ids, _ = tentex
    with session_factory()() as session:
        deck, job = import_project(
            session,
            str(ids["project"]),
            TentexProjectImport(
                use_answers=False, use_cards=False, items_per_question=5, title="Новая колода"
            ),
        )
        questions = list(session.scalars(select(Question).where(Question.deck_id == deck.id)))
        assert deck.title == "Новая колода" and job.total == 2
        assert all(q.answer_text is None and q.items_target == 5 for q in questions)
        assert deck.options["tentex_cards"] == {}


def test_providers_transfer_keys_local_url_defaults_and_idempotency(tentex):
    _root, path, ids, _ = tentex
    before = (path.stat().st_size, path.stat().st_mtime_ns)
    with session_factory()() as session:
        providers = list_providers(session)
        assert len(providers) == 2
        assert all(p["decryptable"] and not p["already_imported"] for p in providers)
        assert providers[1]["base_url"] == "http://localhost:1234/v1"
        result = import_providers(session, TentexProvidersImport())
        dumped = result.model_dump(mode="json")
        assert "tentex-test-secret" not in json.dumps(dumped)
        cloud = session.scalar(
            select(AiProviderConnection).where(AiProviderConnection.label == "Облачный провайдер")
        )
        assert decrypt_secret(cloud.api_key_ciphertext) == "tentex-test-secret"
        with closing(sqlite3.connect(path)) as db, db:
            raw = db.execute(
                "SELECT api_key_ciphertext FROM ai_provider_connections WHERE id=?",
                (ids["provider"].hex,),
            ).fetchone()[0]
        assert cloud.api_key_ciphertext != raw
        settings = session.get(AiSettings, 1)
        assert settings.default_text_model_id == "test-model"
        assert (
            session.get(AiProviderConnection, settings.default_text_provider_id).base_url
            == "http://localhost:1234/v1"
        )
        import_providers(session, TentexProvidersImport())
        assert len(list(session.scalars(select(AiProviderConnection)))) == 2
        assert len(list(session.scalars(select(AiModelCatalogEntry)))) == 2
        assert all(p["already_imported"] for p in list_providers(session))
    assert (path.stat().st_size, path.stat().st_mtime_ns) == before
    assert not path.with_name(path.name + "-wal").exists()
    assert not path.with_name(path.name + "-shm").exists()


def test_provider_wrong_and_missing_secret(tentex, monkeypatch):
    root, _path, ids, _key = tentex
    (root / "data" / "installation.secret").write_bytes(Fernet.generate_key())
    with session_factory()() as session:
        assert not next(p for p in list_providers(session) if p["has_api_key"])["decryptable"]
        with pytest.raises(DomainError) as error:
            import_providers(session, TentexProvidersImport(provider_ids=[str(ids["provider"])]))
        assert error.value.code == "tentex_secret_mismatch"
        assert not list(session.scalars(select(AiProviderConnection)))
        (root / "data" / "installation.secret").unlink()
        with pytest.raises(DomainError) as error:
            import_providers(session, TentexProvidersImport(provider_ids=[str(ids["provider"])]))
        assert error.value.code == "tentex_secret_missing"


def test_provider_explicit_tentex_secret(tentex, monkeypatch):
    root, _path, ids, key = tentex
    (root / "data" / "installation.secret").unlink()
    monkeypatch.setenv("SS_TENTEX_SECRET_KEY", key.decode())
    get_settings.cache_clear()
    with session_factory()() as session:
        import_providers(
            session, TentexProvidersImport(provider_ids=[str(ids["provider"])], set_default=False)
        )
        provider = session.scalar(select(AiProviderConnection))
        assert decrypt_secret(provider.api_key_ciphertext) == "tentex-test-secret"


def test_missing_and_empty_project(tentex):
    root, path, ids, _ = tentex
    with pytest.raises(DomainError) as error:
        TentexReader(root).project(str(uuid4()))
    assert error.value.code == "tentex_project_not_found"
    with closing(sqlite3.connect(path)) as db, db:
        db.execute("DELETE FROM cards")
        db.execute("DELETE FROM program_nodes")
    with session_factory()() as session:
        with pytest.raises(DomainError) as error:
            import_project(session, str(ids["project"]), TentexProjectImport())
    assert error.value.code == "tentex_project_empty"
    path.unlink()
    assert not TentexReader(root).status()["db_found"]
    with pytest.raises(DomainError) as error:
        TentexReader(root).projects()
    assert error.value.code == "tentex_not_found"


def test_http_tentex_routes_model_preflight_job_and_secret_hiding(tentex, monkeypatch):
    from app.main import app
    from app.pipeline import jobs
    from app.tentex.router import router

    _root, _path, ids, _ = tentex
    isolated = FastAPI(exception_handlers=app.exception_handlers)
    isolated.include_router(router)
    started = []
    monkeypatch.setattr(jobs, "start_job", started.append)
    with TestClient(isolated) as http:
        status = http.get("/api/tentex/status")
        assert status.status_code == 200 and status.json()["projects_count"] == 1
        assert http.get("/api/tentex/projects").json()[0]["id"] == str(ids["project"])
        denied = http.post(f"/api/tentex/projects/{ids['project']}/import", json={})
        assert denied.status_code == 409
        providers = http.get("/api/tentex/providers")
        assert providers.status_code == 200
        configured = http.post("/api/tentex/providers/import", json={})
        assert configured.status_code == 200
        assert "tentex-test-secret" not in configured.text
        assert "api_key_ciphertext" not in configured.text
        response = http.post(
            f"/api/tentex/projects/{ids['project']}/import", json={"title": "Моя колода"}
        )
        assert response.status_code == 202
        assert started == [response.json()["job_id"]]
        with session_factory()() as session:
            job = session.get(GenerationJob, started[0])
            assert job.deck_id == response.json()["deck_id"]
            assert job.kind == "tentex_import"


def _generation_payload(prompt, correct, far, near):
    return {
        "items": [
            {
                "prompt": prompt,
                "correct": correct,
                "distractors_far": [
                    {"text": text, "why_wrong": "Этот термин обозначает другую сущность."}
                    for text in far
                ],
                "distractors_near": [
                    {"text": text, "why_wrong": "Это другое свойство или другая структура."}
                    for text in near
                ],
                "explanation": "Верный термин соответствует определению.",
                "source": "ai_knowledge",
                "evidence_quote": "",
            }
        ],
        "skipped_reason": "",
    }


async def test_tentex_cards_become_quiz_items_with_real_jobs_and_fake_transport(
    tentex, monkeypatch
):
    from app.ai.client import AiClient
    from app.ai.provider import FakeTransport, ProviderCompletion, ProviderUsage
    from app.pipeline import jobs

    _root, path, ids, _ = tentex
    before = (path.stat().st_size, path.stat().st_mtime_ns, path.read_bytes())
    with session_factory()() as session:
        import_providers(session, TentexProvidersImport())
        # Проверяем преобразование по одной карточке, без добора режима «авто».
        deck, job = import_project(
            session, str(ids["project"]), TentexProjectImport(items_per_question=1)
        )
        job_id, deck_id = job.id, deck.id
    payloads = [
        _generation_payload(
            "Какое свойство исключает частичный результат операции?",
            "Атомарность",
            ["Параллелизм", "Избыточность", "Фрагментация"],
            ["Изоляция", "Целостность", "Стабильность", "Согласованность"],
        ),
        _generation_payload(
            "Как называется структура для доступа по ключу?",
            "Индекс",
            ["Таблица", "Запись", "Схема"],
            ["Столбец", "Журнал", "Ключ", "Блок"],
        ),
        _generation_payload(
            "Что сокращает время поиска записи в таблице?",
            "Индекс",
            ["Таблица", "Запись", "Схема"],
            ["Столбец", "Журнал", "Ключ", "Блок"],
        ),
    ]
    transport = FakeTransport(
        completions=[
            ProviderCompletion(
                json.dumps(payload, ensure_ascii=False), "test-model", ProviderUsage(20, 20)
            )
            for payload in payloads
        ]
    )
    monkeypatch.setattr(jobs, "AiClient", lambda: AiClient(transport=transport, retry_backoff=(0,)))
    manager = jobs.JobManager()
    try:
        await asyncio.wait_for(manager.start(job_id), timeout=15)
    finally:
        await manager.close()
    with session_factory()() as session:
        job = session.get(GenerationJob, job_id)
        assert job.state == "done", job.error
        items = list(
            session.scalars(
                select(QuizItem).where(QuizItem.deck_id == deck_id).order_by(QuizItem.seq)
            )
        )
        assert [item.seq for item in items] == [1, 2, 3]
        assert sum(item.source == "tentex_card" for item in items) == 2
        assert job.ready_items == 3
        for item in items:
            assert sum(d["kind"] == "far" for d in item.distractors) >= 2
            assert sum(d["kind"] == "near" for d in item.distractors) >= 3
    assert transport.complete_calls == 3
    assert '"mode": "from_card"' in transport.complete_requests[0]["messages"][1]["content"]
    assert (path.stat().st_size, path.stat().st_mtime_ns, path.read_bytes()) == before
    assert not path.with_name(path.name + "-wal").exists()
    assert not path.with_name(path.name + "-shm").exists()
