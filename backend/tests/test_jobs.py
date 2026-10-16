import asyncio
import hashlib
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from test_ai_client import configured as configured_model

from app.ai.client import AiClient
from app.ai.models import AiSettings
from app.ai.provider import FakeTransport, ProviderCompletion, ProviderUsage
from app.config import get_settings
from app.core.text import norm_option
from app.db import session_factory
from app.models import GenerationJob, Question, SourceDoc
from app.pipeline import jobs
from app.pipeline.generate import generate_question
from app.pipeline.validate import same_option, validate_item

configured = configured_model

PROMPTS = [
    "Что измеряют в единицах СИ джоулях?",
    "Какая величина сохраняется в замкнутой системе?",
    "Что меняется при совершении механической работы?",
]


def wire(prompt=PROMPTS[0], **overrides):
    return {
        "prompt": prompt,
        "correct": "Энергия",
        "distractors_far": [
            {"text": text, "why_wrong": "Измеряется в других единицах"}
            for text in ["Плотность", "Длина пути", "Температура"]
        ],
        "distractors_near": [
            {"text": text, "why_wrong": "Это другая физическая величина"}
            for text in ["Мощность", "Импульс", "Давление"]
        ],
        "explanation": "Единица СИ для этой величины — джоуль.",
        "source": "ai_knowledge",
        "evidence_quote": "",
        **overrides,
    }


def completion(items):
    return ProviderCompletion(
        json.dumps({"items": items, "skipped_reason": ""}, ensure_ascii=False),
        "test-model",
        ProviderUsage(10, 20),
    )


def wait_job(client, job_id, states=("done", "failed"), timeout=5):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = client.get(f"/api/jobs/{job_id}")
        assert result.status_code == 200, result.text
        if result.json()["state"] in states:
            return result.json()
        time.sleep(0.01)
    pytest.fail(f"Задача не достигла {states}: {result.text}")


def start(client, count=3, **options):
    response = client.post(
        "/api/imports/quick",
        files={
            "files[]": (
                "questions.txt",
                "\n".join(
                    f"{i + 1}. {text}"
                    for i, text in enumerate(
                        [
                            "Работа и единицы измерения",
                            "Законы сохранения системы",
                            "Тепловые процессы и работа",
                        ][:count]
                    )
                ).encode(),
            )
        },
        data={
            "options": json.dumps(
                {"items_per_question": 1, "roles": {"questions.txt": "questions"}, **options}
            )
        },
    )
    assert response.status_code == 202, response.text
    return response.json()


def inject(monkeypatch, transport):
    monkeypatch.setattr(jobs, "AiClient", lambda: AiClient(transport, retry_backoff=(0,)))
    from app.pipeline import router

    monkeypatch.setattr(router, "AiClient", lambda: AiClient(transport, retry_backoff=(0,)))


def test_extracting_returns_before_parse_and_resumes(configured, client, monkeypatch):
    entered, gate = threading.Event(), threading.Event()
    extract = jobs.extract_document

    def blocked_extract(*args):
        entered.set()
        assert gate.wait(5)
        return extract(*args)

    monkeypatch.setattr(jobs, "extract_document", blocked_extract)
    inject(monkeypatch, FakeTransport(completions=[completion([wire(p)]) for p in PROMPTS]))
    try:
        result = start(client)
        assert entered.wait(2)
        assert client.get(f"/api/jobs/{result['job_id']}").json()["state"] == "extracting"
        detail = client.get(f"/api/decks/{result['deck_id']}").json()
        assert detail["sources"][0]["char_count"] == 0
        assert "imports" not in detail["options"]
        assert client.post(f"/api/jobs/{result['job_id']}/cancel").json()["state"] == "cancelled"
        paths = list((get_settings().data_dir / "uploads").iterdir())
        assert len(paths) == 1
        edited = client.patch(
            f"/api/decks/{result['deck_id']}",
            json={"title": "Обновлённая колода"},
        )
        assert edited.status_code == 200 and edited.json()["title"] == "Обновлённая колода"
        assert "imports" not in edited.json()["options"]
        raw_hash = hashlib.sha256(paths[0].read_bytes()).hexdigest()
        gate.set()
        assert client.post(f"/api/jobs/{result['job_id']}/resume").status_code == 200
        assert wait_job(client, result["job_id"])["state"] == "done"
        with session_factory()() as session:
            source = session.scalar(select(SourceDoc).where(SourceDoc.deck_id == result["deck_id"]))
            assert source.sha256 == raw_hash and source.text and source.blocks
        assert client.delete(f"/api/decks/{result['deck_id']}").status_code == 204
        assert not paths[0].exists()
    finally:
        gate.set()


def test_auto_roles_visible_while_structuring(configured, client, monkeypatch):
    entered, gate = threading.Event(), threading.Event()
    structure = jobs.structure_documents

    async def blocked_structure(*args, **kwargs):
        entered.set()
        await asyncio.to_thread(gate.wait, 5)
        return await structure(*args, **kwargs)

    monkeypatch.setattr(jobs, "structure_documents", blocked_structure)
    inject(monkeypatch, FakeTransport(completions=[completion([wire(p)]) for p in PROMPTS]))
    try:
        result = start(client, roles={})
        assert entered.wait(2)
        job = client.get(f"/api/jobs/{result['job_id']}").json()
        assert job["state"] == "structuring"
        assert job["sources"] == [{"filename": "questions.txt", "role": "questions"}]
        gate.set()
        assert wait_job(client, result["job_id"])["sources"][0]["role"] == "questions"
    finally:
        gate.set()


def test_rejected_import_cleans_only_its_uploads(configured, client, monkeypatch):
    gate = threading.Event()
    extract = jobs.extract_document

    def blocked_extract(*args):
        assert gate.wait(5)
        return extract(*args)

    monkeypatch.setattr(jobs, "extract_document", blocked_extract)
    inject(monkeypatch, FakeTransport())
    try:
        result = start(client)
        paths = set((get_settings().data_dir / "uploads").iterdir())
        response = client.post(
            "/api/imports/quick",
            files={"files": ("other.txt", b"1. question")},
            data={"options": json.dumps({"deck_id": result["deck_id"]})},
        )
        assert response.status_code == 409 and response.json()["code"] == "job_state_conflict"
        assert set((get_settings().data_dir / "uploads").iterdir()) == paths
        assert client.delete(f"/api/decks/{result['deck_id']}").status_code == 204
        assert not list((get_settings().data_dir / "uploads").iterdir())
    finally:
        gate.set()


def test_invalid_pdf_fails_background_job(configured, client, monkeypatch):
    inject(monkeypatch, FakeTransport())
    response = client.post("/api/imports/quick", files={"files": ("broken.pdf", b"not a PDF")})
    assert response.status_code == 202
    job = wait_job(client, response.json()["job_id"])
    assert job["state"] == "failed" and job["error"]["code"] == "import_file_invalid"


def test_delete_waits_for_upload_reader(configured, client, monkeypatch):
    gate, entered = threading.Event(), threading.Event()
    read_bytes = Path.read_bytes

    def locked_read(path):
        if path.parent.name != "uploads":
            return read_bytes(path)
        with path.open("rb") as stream:
            entered.set()
            assert gate.wait(5)
            return stream.read()

    monkeypatch.setattr(Path, "read_bytes", locked_read)
    inject(monkeypatch, FakeTransport())
    try:
        result = start(client)
        assert entered.wait(2)
        with ThreadPoolExecutor() as pool:
            deletion = pool.submit(client.delete, f"/api/decks/{result['deck_id']}")
            # Чтение удерживает исходный файл открытым; удаление должно ждать его закрытия.
            time.sleep(0.05)
            assert not deletion.done()
            gate.set()
            assert deletion.result(timeout=5).status_code == 204
        assert not list((get_settings().data_dir / "uploads").iterdir())
    finally:
        gate.set()


@pytest.mark.parametrize(
    "url,limit", [("http://localhost:1234/v1", 1), ("https://ai.example/v1", 4)]
)
async def test_extract_and_generate_share_concurrency(url, limit):
    manager = SimpleNamespace(local=asyncio.Semaphore(1), cloud=asyncio.Semaphore(4))
    active = maximum = 0
    gate, occupied, full = asyncio.Event(), asyncio.Event(), asyncio.Event()

    class Client:
        def resolve(self, role):
            return SimpleNamespace(
                provider=SimpleNamespace(base_url=url), serial_execution=limit == 1
            )

        async def complete(self, **kwargs):
            nonlocal active, maximum
            active += 1
            maximum = max(maximum, active)
            if active == limit - 1:
                occupied.set()
            if active == limit:
                full.set()
            await gate.wait()
            active -= 1

    semaphore = manager.local if limit == 1 else manager.cloud
    await semaphore.acquire()
    limited = jobs.LimitedExtractClient(Client(), manager)
    pending = [asyncio.create_task(limited.complete(role="extract")) for _ in range(8)]
    if limit > 1:
        await asyncio.wait_for(occupied.wait(), 1)
    else:
        await asyncio.sleep(0)
    assert maximum == limit - 1
    semaphore.release()
    await asyncio.wait_for(full.wait(), 1)
    gate.set()
    await asyncio.gather(*pending)
    assert maximum == limit


def test_progressive_seq_cancel_and_resume(configured, client, monkeypatch):
    gate = threading.Event()

    class GatedTransport(FakeTransport):
        async def complete(self, **kwargs):
            if len(self.complete_requests) == 1 and not gate.is_set():
                while not gate.is_set():
                    await asyncio.sleep(0.01)
            return await super().complete(**kwargs)

    fake = GatedTransport(completions=[completion([wire(p)]) for p in PROMPTS])
    inject(monkeypatch, fake)
    result = start(client)
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline:
        page = client.get(f"/api/decks/{result['deck_id']}/items").json()
        if page["items"]:
            break
        time.sleep(0.01)
    assert page["job_active"] and page["next_since"] == 1
    cancelled = client.post(f"/api/jobs/{result['job_id']}/cancel")
    assert cancelled.status_code == 200 and cancelled.json()["state"] == "cancelled"
    assert cancelled.json()["can_play"] is True
    assert client.get(f"/api/decks/{result['deck_id']}/items").json()["total_ready"] == 1
    gate.set()
    assert client.post(f"/api/jobs/{result['job_id']}/resume").status_code == 200
    finished = wait_job(client, result["job_id"])
    assert finished["state"] == "done" and finished["done"] == 3
    page = client.get(f"/api/decks/{result['deck_id']}/items?since=1").json()
    assert [i["seq"] for i in page["items"]] == [2, 3]
    assert finished["usage"]["input_tokens"] == 30


def test_cost_confirm_and_conflicting_state(configured, client, monkeypatch):
    with session_factory()() as session:
        session.get(AiSettings, 1).confirm_cost_usd = 0
        session.commit()
    fake = FakeTransport(completions=[completion([wire(p)]) for p in PROMPTS])
    inject(monkeypatch, fake)
    result = start(client)
    job = wait_job(client, result["job_id"], ("awaiting_confirm",))
    assert job["estimate"]["requires_confirm"] and fake.complete_requests == []
    assert client.post(f"/api/jobs/{result['job_id']}/confirm").status_code == 200
    assert wait_job(client, result["job_id"])["state"] == "done"
    assert client.post(f"/api/jobs/{result['job_id']}/confirm").status_code == 409


def test_recovery_and_monotonic_after_delete(configured, client, monkeypatch):
    fake = FakeTransport(
        completions=[
            completion([wire(p)])
            for p in [*PROMPTS, "Какую величину передают телу при нагревании?"]
        ]
    )
    inject(monkeypatch, fake)
    result = start(client)
    assert wait_job(client, result["job_id"])["state"] == "done"
    page = client.get(f"/api/decks/{result['deck_id']}/items").json()
    item = page["items"][-1]
    assert client.delete(f"/api/items/{item['id']}").status_code == 204
    with session_factory()() as session:
        job = session.get(GenerationJob, result["job_id"])
        job.state = "generating"
        for question in session.scalars(
            select(Question).where(Question.deck_id == result["deck_id"])
        ):
            if question.id == item["question_id"]:
                question.status = "generating"
        session.commit()
    jobs.recover_jobs()
    assert client.get(f"/api/jobs/{result['job_id']}").json()["state"] == "interrupted"
    assert client.post(f"/api/jobs/{result['job_id']}/resume").status_code == 200
    assert wait_job(client, result["job_id"])["state"] == "done"
    page = client.get(f"/api/decks/{result['deck_id']}/items?since=3").json()
    assert [i["seq"] for i in page["items"]] == [4]


def test_unconfigured_fails_before_job_creation(client):
    response = client.post("/api/imports/quick", data={"text": "Как найти производную?"})
    assert response.status_code == 409
    assert response.json()["code"] in ("ai_model_not_configured", "ai_disabled")
    assert client.get("/api/decks").json() == []


async def test_quote_repair_then_downgrade_and_duplicates(configured):
    invalid = wire(source="user_docs", evidence_quote="Выдуманная цитата без основания")
    fake = FakeTransport(completions=[completion([invalid]), completion([invalid, invalid])])
    question = Question(
        text="Единицы измерения",
        section=None,
        items_target=1,
        answer_text="Энергия в международной системе единиц измеряется в джоулях.",
    )
    result = await generate_question(AiClient(fake), question)
    assert len(fake.complete_requests) == 2
    assert len(result.items) == 1
    assert result.items[0]["source"] == "ai_knowledge" and result.items[0]["evidence_quote"] is None
    assert result.warnings[0]["code"] == "quote_downgraded"


async def test_length_imbalance_rejected_after_one_repair(configured):
    invalid = wire(correct="Необычайно длинный полный ответ на экзаменационный вопрос")
    fake = FakeTransport(completions=[completion([invalid]), completion([invalid])])
    question = Question(text="Единицы измерения", section=None, items_target=1, answer_text=None)
    result = await generate_question(AiClient(fake), question)
    assert result.items == [] and result.error
    assert len(fake.complete_requests) == 2


def test_math_signs_and_numeric_answers_remain_distinct():
    assert norm_option("-1") != norm_option("1")
    assert norm_option("кто-то") == norm_option("кто то")
    assert not same_option("$ax+by+cz+dw+ev$", "$ax-by+cz+dw+ev$")
    assert same_option("Правильный ответ", "Правильный ответ!")
    candidate = wire()
    distractors = [
        {**d, "kind": kind}
        for kind, pool in (
            ("far", candidate["distractors_far"]),
            ("near", candidate["distractors_near"]),
        )
        for d in pool
    ]
    candidate["distractors"] = distractors
    assert validate_item(candidate)[1] == []


def test_question_and_item_regeneration(configured, client, monkeypatch):
    extra = "Какую величину передают телу при нагревании?"
    fake = FakeTransport(completions=[completion([wire(p)]) for p in [*PROMPTS, extra, extra]])
    inject(monkeypatch, fake)
    result = start(client)
    assert wait_job(client, result["job_id"])["state"] == "done"
    items = client.get(f"/api/decks/{result['deck_id']}/items").json()["items"]
    response = client.post(
        f"/api/decks/{result['deck_id']}/questions/{items[0]['question_id']}/regenerate",
        json={"items_per_question": 1},
    )
    assert response.status_code == 202, response.text
    assert wait_job(client, response.json()["job_id"])["state"] == "done"
    page = client.get(f"/api/decks/{result['deck_id']}/items?since=3").json()
    assert page["items"][0]["seq"] == 4
    previous_calls = len(fake.complete_requests)
    response = client.post(f"/api/items/{items[0]['id']}/regenerate", json={"mode": "distractors"})
    assert response.status_code == 200, response.text
    assert response.json()["prompt"] == items[0]["prompt"]
    assert response.json()["correct"] == items[0]["correct"]
    assert len(fake.complete_requests) == previous_calls + 1


def test_import_and_patch_validate_user_evidence(client):
    from app.config import ROOT

    data = json.loads((ROOT / "fixtures/demo-deck.ssdeck.json").read_text("utf-8"))
    candidate = wire(
        source="user_docs", evidence_quote="Полностью выдуманная цитата из чужого текста"
    )
    candidate["distractors"] = [
        {**d, "kind": kind}
        for kind, pool in (
            ("far", candidate.pop("distractors_far")),
            ("near", candidate.pop("distractors_near")),
        )
        for d in pool
    ]
    data["items"] = [{"uid": "test", "question_uid": "q1", "enabled": True, **candidate}]
    response = client.post("/api/decks/import", files={"file": ("bad.json", json.dumps(data))})
    assert response.status_code == 422 and response.json()["code"] == "deck_file_invalid"
    data["items"][0]["enabled"] = False
    response = client.post("/api/decks/import", files={"file": ("disabled.json", json.dumps(data))})
    assert response.status_code == 201, response.text
    item = client.get(f"/api/decks/{response.json()['id']}/items?include_disabled=true").json()[
        "items"
    ][0]
    response = client.patch(f"/api/items/{item['id']}", json={"enabled": True})
    assert response.status_code == 422 and response.json()["code"] == "item_invalid"
