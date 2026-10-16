import json

from test_ai_client import configured as configured_model
from test_jobs import PROMPTS, completion, inject, start, wait_job, wire

from app.ai.provider import FakeTransport, ProviderCompletion, ProviderUsage
from app.pipeline.title import TITLE_PROMPT, clean_title, title_from_files
from app.pipeline.validate import validate_item

configured = configured_model


def titled(title):
    return ProviderCompletion(
        json.dumps({"title": title}, ensure_ascii=False), "test-model", ProviderUsage(5, 5)
    )


class RoutedTransport(FakeTransport):
    """Название и карточки отвечают из разных очередей: порядок параллельных задач не важен."""

    def __init__(self, title, cards):
        super().__init__()
        self.titles, self.cards = [title], list(cards)

    async def complete(self, **kwargs):
        self.complete_calls += 1
        self.complete_requests.append(kwargs)
        naming = kwargs["messages"][0]["content"] == TITLE_PROMPT
        queue = self.titles if naming else self.cards
        return queue.pop(0)


def test_clean_title_and_file_fallback():
    assert clean_title(" «колода: Экология популяций.» ") == "Экология популяций"
    assert clean_title("   ") is None
    assert len(clean_title("Очень длинное название " * 6)) <= 60
    assert title_from_files(["questions.txt"]) is None
    assert title_from_files(["Вопросы к экзамену.docx", "ответы.pdf"]) is None
    assert title_from_files(["Вставленный текст"]) is None
    assert title_from_files(["вопросы.docx", "экология_популяций-2024.pdf"]) == (
        "Экология популяций 2024"
    )


def test_import_names_deck_by_model_unless_user_renamed(configured, client, monkeypatch):
    transport = RoutedTransport(
        titled("Физика: энергия и работа"), [completion([wire(p)]) for p in PROMPTS]
    )
    inject(monkeypatch, transport)
    result = start(client, auto_title=True)
    assert wait_job(client, result["job_id"])["state"] == "done"
    deck = client.get(f"/api/decks/{result['deck_id']}").json()
    assert deck["title"] == "Физика: энергия и работа"
    assert "auto_title" not in deck["options"]

    # Без auto_title модель не зовут, название — запасное.
    plain_transport = RoutedTransport(titled("Не нужно"), [completion([wire(p)]) for p in PROMPTS])
    inject(monkeypatch, plain_transport)
    plain = start(client)
    assert wait_job(client, plain["job_id"])["state"] == "done"
    assert client.get(f"/api/decks/{plain['deck_id']}").json()["title"] == "Новая колода"
    assert plain_transport.titles


def test_card_must_not_point_to_source():
    item = {
        "prompt": "Какой пример паразитизма приводится в источнике?",
        "correct": "Клещ на позвоночном",
        "distractors": [],
        "explanation": "",
    }
    _, issues = validate_item(item, prune=True)
    assert any("ссылается на источник" in issue for issue in issues)
    _, issues = validate_item({**item, "prompt": "Какой организм — пример паразита?"}, prune=True)
    assert not any("ссылается на источник" in issue for issue in issues)
