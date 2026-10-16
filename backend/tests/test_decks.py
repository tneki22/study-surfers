import json

from app.config import ROOT
from app.db import session_factory
from app.decks.export import import_deck, parse_deck_file


def demo(client):
    with session_factory()() as session:
        deck = import_deck(
            session, parse_deck_file((ROOT / "fixtures/demo-deck.ssdeck.json").read_bytes()), "demo"
        )
        return deck.id


def test_demo_and_cursor(client):
    deck_id = demo(client)
    page = client.get(f"/api/decks/{deck_id}/items").json()
    assert len(page["items"]) == 16
    assert page["next_since"] == 16
    assert client.get(f"/api/decks/{deck_id}/items?since=10").json()["items"][0]["seq"] == 11
    assert client.get(f"/api/decks/{deck_id}/items?since=16").json()["items"] == []


def test_roundtrip_and_invalid_file(client):
    deck_id = demo(client)
    exported = client.get(f"/api/decks/{deck_id}/export")
    imported = client.post(
        "/api/decks/import", files={"file": ("deck.ssdeck.json", exported.content)}
    )
    assert imported.status_code == 201, imported.text
    page = client.get(f"/api/decks/{imported.json()['id']}/items").json()
    source = client.get(f"/api/decks/{deck_id}/items").json()
    for a, b in zip(page["items"], source["items"], strict=True):
        for k in (
            "prompt",
            "correct",
            "distractors",
            "explanation",
            "source",
            "evidence_quote",
            "section",
            "enabled",
        ):
            assert a[k] == b[k]
    bad = client.post("/api/decks/import", files={"file": ("bad.json", b"{}")})
    assert bad.status_code == 422
    assert bad.json()["code"] == "deck_file_invalid"
    bad = client.post("/api/decks/import", files={"file": ("bad.json", json.dumps({"version": 1}))})
    assert bad.json()["code"] == "deck_file_invalid"


def test_item_patch_and_cascade(client):
    deck_id = demo(client)
    item = client.get(f"/api/decks/{deck_id}/items").json()["items"][0]
    response = client.patch(
        f"/api/items/{item['id']}", json={"correct": item["distractors"][0]["text"]}
    )
    assert response.status_code == 422
    assert response.json()["code"] == "item_invalid"
    assert client.patch(f"/api/items/{item['id']}", json={"enabled": False}).status_code == 200
    assert client.get(f"/api/decks/{deck_id}/items").json()["total_ready"] == 15
    assert client.delete(f"/api/decks/{deck_id}").status_code == 204
    assert client.get(f"/api/decks/{deck_id}").status_code == 404


def test_validation_error(client):
    response = client.post("/api/decks", json={"title": ""})
    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert response.json()["context"]["errors"]


def test_unknown_fields_and_duplicate_uid(client):
    data = json.loads((ROOT / "fixtures/demo-deck.ssdeck.json").read_text("utf-8"))
    data["items"][1]["uid"] = data["items"][0]["uid"]
    response = client.post("/api/decks/import", files={"file": ("bad.json", json.dumps(data))})
    assert response.status_code == 422
    assert response.json()["code"] == "deck_file_invalid"
