import json

from test_jobs import PROMPTS, completion, configured, inject, start, wait_job, wire

from app.ai.provider import FakeTransport
from app.pipeline.prompts import DEFAULT_LEARNER_PROMPT, LEARNER_PROMPT_MAX, generation_prompt

__all__ = ["configured"]

LEARNER = "Я только начинаю. Спрашивай основу и объясняй на примерах из жизни."


def system_prompts(fake):
    return [request["messages"][0]["content"] for request in fake.complete_requests]


def test_generation_prompt_appends_learner_block_after_fixed_rules():
    default = generation_prompt()
    custom = generation_prompt(f"  {LEARNER}  ")
    fixed = default[: default.index("<learner> —")]
    # Постоянная часть одинакова при любых пожеланиях: её кеширует провайдер.
    assert custom.startswith(fixed)
    assert custom.endswith(f"<learner>\n{LEARNER}\n</learner>\n")
    assert default.endswith(f"<learner>\n{DEFAULT_LEARNER_PROMPT}\n</learner>\n")
    assert generation_prompt("   ") == default
    assert len(generation_prompt("я" * 5000)) == len(generation_prompt("я" * LEARNER_PROMPT_MAX))


def test_presets_endpoint(client):
    body = client.get("/api/imports/learner-presets").json()
    ids = [preset["id"] for preset in body["presets"]]
    assert body["default_id"] in ids and len(ids) == 3
    assert body["max_length"] == LEARNER_PROMPT_MAX
    default = next(p for p in body["presets"] if p["id"] == body["default_id"])
    assert default["text"] == DEFAULT_LEARNER_PROMPT
    assert all(len(p["text"]) <= LEARNER_PROMPT_MAX for p in body["presets"])


def test_learner_prompt_reaches_import_and_regeneration(configured, client, monkeypatch):
    extras = ["Какую величину передают телу при нагревании?", "Что запасает сжатая пружина?"]
    fake = FakeTransport(completions=[completion([wire(p)]) for p in [*PROMPTS, *extras]])
    inject(monkeypatch, fake)
    result = start(client, learner_prompt=LEARNER)
    assert wait_job(client, result["job_id"])["state"] == "done"
    items = client.get(f"/api/decks/{result['deck_id']}/items").json()["items"]
    response = client.post(
        f"/api/decks/{result['deck_id']}/questions/{items[0]['question_id']}/regenerate",
        json={"items_per_question": 1},
    )
    assert wait_job(client, response.json()["job_id"])["state"] == "done"
    response = client.post(f"/api/items/{items[0]['id']}/regenerate", json={"mode": "full"})
    assert response.status_code == 200, response.text
    prompts = system_prompts(fake)
    assert len(prompts) == 5
    assert all(p.endswith(f"<learner>\n{LEARNER}\n</learner>\n") for p in prompts)


def test_import_without_learner_prompt_uses_default(configured, client, monkeypatch):
    fake = FakeTransport(completions=[completion([wire(p)]) for p in PROMPTS])
    inject(monkeypatch, fake)
    result = start(client, learner_prompt="   ")
    assert wait_job(client, result["job_id"])["state"] == "done"
    assert all(p == generation_prompt() for p in system_prompts(fake))


def test_too_long_learner_prompt_rejected(configured, client):
    response = client.post(
        "/api/imports/quick",
        data={"options": json.dumps({"learner_prompt": "я" * (LEARNER_PROMPT_MAX + 1)})},
        files={"files[]": ("q.txt", b"1. Work")},
    )
    assert response.status_code == 422
