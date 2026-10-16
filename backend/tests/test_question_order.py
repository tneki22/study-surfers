import json

from app.config import ROOT
from app.db import session_factory
from app.decks.export import import_deck, parse_deck_file


def test_items_expose_program_order_independently_of_seq(client):
    data = json.loads((ROOT / "fixtures/demo-deck.ssdeck.json").read_text("utf-8"))
    data["items"].reverse()
    with session_factory()() as session:
        deck_id = import_deck(session, parse_deck_file(json.dumps(data).encode()), "demo").id
    questions = client.get(f"/api/decks/{deck_id}/questions").json()
    ordinals = {q["id"]: q["ordinal"] for q in questions}
    page = client.get(f"/api/decks/{deck_id}/items").json()
    for item in page["items"]:
        assert item["question_ordinal"] == ordinals.get(item["question_id"])
    grouped = [i for i in page["items"] if i["question_id"]]
    assert grouped[0]["question_ordinal"] > grouped[-1]["question_ordinal"]
