import io
import json
import sqlite3
import zipfile

import pytest
from test_ai_client import configured as configured_model
from test_jobs import completion, inject, wait_job, wire

from app.ai.provider import FakeTransport
from app.flashcards.convert import auto_mapping, make_prompt, plan_cards
from app.flashcards.reader import NoteType, clean_field, read_flashcards
from app.flashcards.schemas import FlashcardOptions
from app.pipeline.validate import validate_item

configured = configured_model

WORDS = [
    ("apple", "яблоко"),
    ("house", "дом"),
    ("river", "река"),
    ("window", "окно"),
    ("garden", "сад"),
    ("bridge", "мост"),
    ("cloud", "облако"),
    ("forest", "лес"),
    ("city", "город"),
    ("street", "улица"),
    ("winter", "зима"),
    ("summer", "лето"),
]
LONG_BACK = (
    "Экосистема — совокупность живых организмов и среды их обитания, связанных обменом "
    "веществ и энергии"
)


def legacy_package(notes, *, cloze=None) -> bytes:
    """Пакет Anki со схемой 11: типы заметок и колоды JSON-ом в таблице col."""
    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE col (id integer, models text, decks text);
        CREATE TABLE notes (id integer, guid text, mid integer, mod integer, usn integer,
            tags text, flds text, sfld text, csum integer, flags integer, data text);
        CREATE TABLE cards (id integer, nid integer, did integer, ord integer);
        """
    )
    models = {
        "1": {
            "name": "Basic",
            "type": 0,
            "flds": [{"name": "Front", "ord": 0}, {"name": "Back", "ord": 1}],
        },
        "2": {
            "name": "Cloze",
            "type": 1,
            "flds": [{"name": "Text", "ord": 0}, {"name": "Back Extra", "ord": 1}],
        },
    }
    decks = {"10": {"name": "Английский::Слова"}, "11": {"name": "Английский::Природа"}}
    connection.execute("INSERT INTO col VALUES (1, ?, ?)", (json.dumps(models), json.dumps(decks)))
    rows = [(1, fields, 10 + i % 2) for i, fields in enumerate(notes)]
    rows += [(2, fields, 10) for fields in cloze or []]
    for nid, (mid, fields, did) in enumerate(rows, 1):
        connection.execute(
            "INSERT INTO notes VALUES (?, ?, ?, 0, 0, ?, ?, '', 0, 0, '')",
            (nid, f"g{nid}", mid, " lexis ", "\x1f".join(fields)),
        )
        connection.execute("INSERT INTO cards VALUES (?, ?, ?, 0)", (nid, nid, did))
    return _zip(connection, "collection.anki2")


def modern_package(notes) -> bytes:
    """Схема 18 в collection.anki21b (zstd) и заглушка «обновите Anki» в collection.anki2."""
    import zstandard

    connection = sqlite3.connect(":memory:")
    connection.executescript(
        """
        CREATE TABLE notetypes (id integer, name text, mtime_secs integer, usn integer, config blob);
        CREATE TABLE fields (ntid integer, ord integer, name text, config blob);
        CREATE TABLE decks (id integer, name text);
        CREATE TABLE notes (id integer, guid text, mid integer, mod integer, usn integer,
            tags text, flds text, sfld text, csum integer, flags integer, data text);
        CREATE TABLE cards (id integer, nid integer, did integer, ord integer);
        INSERT INTO notetypes VALUES (7, 'Основная', 0, 0, x'');
        INSERT INTO fields VALUES (7, 0, 'Вопрос', x''), (7, 1, 'Ответ', x''), (7, 2, 'Пример', x'');
        INSERT INTO decks VALUES (3, 'Экология' || char(31) || 'Термины');
        """
    )
    for nid, fields in enumerate(notes, 1):
        connection.execute(
            "INSERT INTO notes VALUES (?, ?, 7, 0, 0, '', ?, '', 0, 0, '')",
            (nid, f"g{nid}", "\x1f".join(fields)),
        )
        connection.execute("INSERT INTO cards VALUES (?, ?, 3, 0)", (nid, nid))
    database = connection.serialize()
    stub = sqlite3.connect(":memory:")
    stub.executescript(
        "CREATE TABLE col (id integer, models text, decks text);"
        "CREATE TABLE notes (id integer, mid integer, flds text, tags text);"
        "INSERT INTO notes VALUES (1, 1, 'Please update to the latest Anki version', '');"
    )
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("collection.anki21b", zstandard.ZstdCompressor().compress(database))
        archive.writestr("collection.anki2", stub.serialize())
        archive.writestr("media", b"")
    return output.getvalue()


def _zip(connection, name) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr(name, connection.serialize())
        archive.writestr("media", "{}")
    return output.getvalue()


def test_clean_field_strips_html_media_and_converts_math():
    raw = 'Сила&nbsp;<b>тока</b><br><img src="a.png">[sound:a.mp3] \\(I = U/R\\)'
    assert clean_field(raw) == "Сила тока\n$I = U/R$"


def test_auto_mapping_by_field_names():
    basic = NoteType("1", "Basic", ["Back", "Front", "Extra"])
    assert auto_mapping(basic).model_dump() == {"question": 1, "answer": 0, "extra": 2}
    cloze = NoteType("2", "Cloze", ["Text", "Back Extra"], cloze=True)
    assert auto_mapping(cloze).model_dump() == {"question": 0, "answer": None, "extra": 1}
    plain = NoteType("3", "Таблица", ["Столбец 1", "Столбец 2"])
    assert auto_mapping(plain).model_dump() == {"question": 0, "answer": 1, "extra": None}


def test_short_front_gets_question_template():
    assert make_prompt("apple", "auto") == "Что означает «apple»?"
    assert make_prompt("Столица Франции?", "auto") == "Столица Франции?"
    assert (
        make_prompt("Какой город — столица", "translate")
        == "Как переводится «Какой город — столица»?"
    )


def test_legacy_package_local_plan():
    data = legacy_package(
        [[en, f"<div>{ru}</div>"] for en, ru in WORDS]
        + [["Экосистема", LONG_BACK], ['<img src="x.png">', "картинка"]],
        cloze=[["{{c1::Москва}} — столица России, {{c2::Париж::город}} — Франции", "Европа"]],
    )
    source = read_flashcards(data, "words.apkg")
    assert source.format == "anki_package"
    assert source.title == "Английский"
    assert {t.name: t.cloze for t in source.note_types.values()} == {"Basic": False, "Cloze": True}

    cards = plan_cards(source, FlashcardOptions(mode="local"), ai_ready=False)
    ready = [c for c in cards if c.plan == "ready"]
    assert len(ready) == len(WORDS)

    for card in ready:
        _, issues = validate_item(card.item)
        assert not issues, issues
        texts = [d["text"] for d in card.item["distractors"]]
        assert card.item["correct"] not in texts
        assert all(not t.isascii() for t in texts), "латиница среди русских ответов выдаёт ответ"
        assert not any(t in card.item["prompt"] for t in texts)
        assert card.item["source"] == "flashcard"
    assert ready[0].item["prompt"] == "Что означает «apple»?"
    assert ready[0].section in ("Слова", "Природа")
    skipped = {c.reason for c in cards if c.plan == "skip"}
    assert any("70 знаков" in r for r in skipped)
    assert any("картинка" in r for r in skipped)

    # Два пропуска не дают пула вариантов: слова из словаря им в варианты не берутся.
    cloze = [c for c in cards if c.kind == "cloze"]
    assert {c.reason for c in cloze} == {"Мало похожих ответов для неверных вариантов"}
    assert [c.front for c in cloze] == [
        "___ — столица России, Париж — Франции",
        "Москва — столица России, ___ (город) — Франции",
    ]
    assert [c.back for c in cloze] == ["Москва", "Париж"]


def test_modern_package_and_reverse_cards():
    data = modern_package([[ru, en, f"Пример {i}"] for i, (en, ru) in enumerate(WORDS)])
    source = read_flashcards(data, "eco.apkg")
    assert source.title == "Термины"
    note_type = next(iter(source.note_types.values()))
    assert note_type.fields == ["Вопрос", "Ответ", "Пример"]

    cards = plan_cards(source, FlashcardOptions(mode="local", reverse=True), ai_ready=False)
    assert len(cards) == 2 * len(WORDS)
    assert all(c.plan == "ready" for c in cards), [c.reason for c in cards if c.plan != "ready"]
    reverse = next(c for c in cards if c.kind == "reverse")
    assert all(not d["text"].isascii() for d in reverse.item["distractors"])
    assert reverse.item["explanation"].startswith("Пример")


def test_text_exports_anki_and_quizlet():
    anki = "#separator:tab\n#html:true\n#deck column:3\n" + "\n".join(
        f"{en}\t{ru}<br>\tСлова" for en, ru in WORDS
    )
    source = read_flashcards(anki.encode(), "export.txt")
    assert source.format == "table"
    assert len(source.notes) == len(WORDS)
    assert source.decks == {"Слова": len(WORDS)}
    assert source.notes[0].fields == ["apple", "яблоко<br>"]

    quizlet = "term,definition\n" + "\n".join(f'"{en}","{ru}, сущ."' for en, ru in WORDS)
    source = read_flashcards(quizlet.encode("cp1251"), "quizlet.csv")
    note_type = next(iter(source.note_types.values()))
    assert note_type.fields == ["term", "definition"]
    assert source.notes[0].fields == ["apple", "яблоко, сущ."]


def test_unsupported_and_broken_files(client):
    response = client.post(
        "/api/imports/flashcards?dry_run=true",
        files={"file": ("cards.pdf", b"%PDF-1.4", "application/pdf")},
    )
    assert response.status_code == 415
    response = client.post(
        "/api/imports/flashcards?dry_run=true",
        files={"file": ("cards.apkg", b"PK\x03\x04broken", "application/zip")},
    )
    assert response.status_code == 422 and response.json()["code"] == "flashcards_file_invalid"


def test_preview_and_local_import_round_trip(client):
    data = legacy_package([[en, ru] for en, ru in WORDS] + [["Экосистема", LONG_BACK]])
    files = {"file": ("words.apkg", data, "application/octet-stream")}
    preview = client.post(
        "/api/imports/flashcards?dry_run=true", files=files, data={"options": "{}"}
    )
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["ai_ready"] is False
    assert body["counts"] == {"total": 13, "ready": 12, "ai": 0, "skipped": 1}
    assert body["reasons"][0]["reason"].startswith("Нужна доработка ИИ")
    assert body["note_types"][0]["examples"][0] == ["apple", "яблоко"]
    assert {d["name"] for d in body["decks"]} == {"Английский::Слова", "Английский::Природа"}

    created = client.post(
        "/api/imports/flashcards",
        files=files,
        data={"options": json.dumps({"title": "Слова", "decks": ["Английский::Слова"]})},
    )
    assert created.status_code == 201, created.text
    result = created.json()
    assert result["job_id"] is None and result["counts"]["ready"] == 6
    deck = client.get(f"/api/decks/{result['deck_id']}").json()
    assert deck["title"] == "Слова" and deck["source_kind"] == "flashcards"
    assert deck["enabled_item_count"] == 6 and deck["status"] == "ready"

    exported = client.get(f"/api/decks/{result['deck_id']}/export")
    assert exported.status_code == 200
    again = client.post(
        "/api/decks/import",
        files={"file": ("deck.ssdeck.json", exported.content, "application/json")},
    )
    assert again.status_code == 201, again.text

    anki = client.get(f"/api/decks/{result['deck_id']}/export?format=anki")
    assert anki.status_code == 200
    assert "anki.txt" in anki.headers["content-disposition"]
    lines = anki.text.splitlines()
    assert lines[:3] == ["#separator:tab", "#html:true", "#deck:Слова"]
    assert len(lines) == 5 + 6
    reread = read_flashcards(anki.content, "deck.anki.txt")
    assert len(reread.notes) == 6 and reread.note_types["table"].fields[:2] == ["Вопрос", "Ответ"]


def test_ai_mode_requires_model(client):
    data = legacy_package([[en, ru] for en, ru in WORDS])
    response = client.post(
        "/api/imports/flashcards",
        files={"file": ("words.apkg", data, "application/octet-stream")},
        data={"options": json.dumps({"mode": "ai"})},
    )
    assert response.status_code == 409 and response.json()["code"] == "ai_model_not_configured"


def test_auto_import_sends_unfit_cards_to_model(configured, client, monkeypatch):
    transport = FakeTransport(completions=[completion([wire("Что такое экосистема в экологии?")])])
    inject(monkeypatch, transport)
    data = legacy_package([[en, ru] for en, ru in WORDS] + [["Экосистема", LONG_BACK]])
    created = client.post(
        "/api/imports/flashcards",
        files={"file": ("words.apkg", data, "application/octet-stream")},
        data={"options": "{}"},
    )
    assert created.status_code == 201, created.text
    result = created.json()
    assert result["counts"] == {"total": 13, "ready": 12, "ai": 1, "skipped": 0}
    job = wait_job(client, result["job_id"])
    assert job["state"] == "done" and job["kind"] == "flashcard_import", job
    items = client.get(f"/api/decks/{result['deck_id']}/items").json()["items"]
    assert len(items) == 13
    generated = [i for i in items if i["prompt"].startswith("Что такое экосистема")]
    assert generated and generated[0]["source"] == "flashcard"
    request = transport.complete_requests[0]["messages"][1]["content"]
    assert "from_card" in request and "Экосистема" in request


@pytest.mark.parametrize("mode", ["auto", "local"])
def test_nothing_usable_is_an_error(client, mode):
    data = legacy_package([["Экосистема", LONG_BACK]])
    response = client.post(
        "/api/imports/flashcards",
        files={"file": ("one.apkg", data, "application/octet-stream")},
        data={"options": json.dumps({"mode": mode})},
    )
    assert response.status_code == 422 and response.json()["code"] == "flashcards_nothing"
