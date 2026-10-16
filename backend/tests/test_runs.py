from datetime import datetime, timedelta
from uuid import uuid4

from test_decks import demo

from app.db import session_factory
from app.models import Run


def body(deck_id, answers):
    return {
        "id": str(uuid4()),
        "deck_id": deck_id,
        "settings": {"lanes": 3, "difficulty": "easy", "filter": "all", "pace": 1, "lives": 3},
        "started_at": "2026-10-13T10:00:00Z",
        "finished_at": "2026-10-13T10:01:00Z",
        "score": 100,
        "distance": 10,
        "max_streak": 1,
        "answers": answers,
    }


def answer(item, ordinal, correct):
    return {
        "item_id": item["id"],
        "ordinal": ordinal,
        "chosen_text": item["correct"] if correct else item["distractors"][0]["text"],
        "chosen_kind": "correct" if correct else item["distractors"][0]["kind"],
        "correct": correct,
        "reaction_ms": 600,
    }


def test_idempotence_streak_mistakes_and_filters(client):
    deck_id = demo(client)
    items = client.get(f"/api/decks/{deck_id}/items").json()["items"]
    request = body(
        deck_id, [answer(items[0], 0, True), answer(items[0], 1, False), answer(items[1], 2, True)]
    )
    first = client.post("/api/runs", json=request)
    assert first.status_code == 201, first.text
    assert first.json()["duration_ms"] == 60000
    assert first.json()["mistakes"][0]["why_wrong"] == items[0]["distractors"][0]["why_wrong"]
    assert client.post("/api/runs", json=request).status_code == 200
    page = client.get(f"/api/decks/{deck_id}/items").json()["items"]
    assert page[0]["stats"]["seen"] == 2
    assert page[0]["stats"]["streak"] == 0
    for filter in ("weak", "last_mistakes"):
        assert [
            i["id"]
            for i in client.get(f"/api/decks/{deck_id}/items?filter={filter}").json()["items"]
        ] == [items[0]["id"]]
    stats = client.get(f"/api/decks/{deck_id}/stats").json()
    assert stats["runs_count"] == 1 and stats["weak_count"] == 1 and stats["seen_count"] == 2
    assert stats["by_section"][0]["accuracy"] == 2 / 3
    assert client.delete(f"/api/items/{items[0]['id']}").status_code == 204
    mistake = client.get(f"/api/runs/{request['id']}").json()["mistakes"][0]
    assert mistake["item_id"] is None
    assert mistake["prompt"] == items[0]["prompt"]


def test_frontend_pace_and_disabled_lives(client):
    deck_id = demo(client)
    item = client.get(f"/api/decks/{deck_id}/items").json()["items"][0]
    for pace, lives in (("normal", None), ("custom:8", 0), ("fast", 3)):
        request = body(deck_id, [answer(item, 0, True)])
        request["settings"].update(pace=pace, lives=lives)
        response = client.post("/api/runs", json=request)
        assert response.status_code == 201, response.text
        assert response.json()["settings"]["pace"] == pace
        assert response.json()["settings"]["lives"] == lives


def test_best_score_is_kept_per_world_and_obstacles(client):
    deck_id = demo(client)
    item = client.get(f"/api/decks/{deck_id}/items").json()["items"][0]
    for score, extra in ((300, {}), (500, {"world": "night-maglev"}), (200, {"obstacles": "off"})):
        request = body(deck_id, [answer(item, 0, True)])
        request["score"] = score
        request["settings"].update(extra)
        assert client.post("/api/runs", json=request).status_code == 201
    deck = client.get(f"/api/decks/{deck_id}").json()
    assert deck["best_score"] == 500
    assert deck["best_by_setup"] == [
        {"world": "classic", "obstacles": "normal", "score": 300},
        {"world": "classic", "obstacles": "off", "score": 200},
        {"world": "night-maglev", "obstacles": "normal", "score": 500},
    ]


def test_cross_deck_rejected_transactionally(client):
    first, second = demo(client), demo(client)
    items = client.get(f"/api/decks/{first}/items").json()["items"]
    response = client.post("/api/runs", json=body(second, [answer(items[0], 0, True)]))
    assert response.status_code == 422 and response.json()["code"] == "run_invalid"
    assert client.get(f"/api/decks/{second}/stats").json()["runs_count"] == 0


def test_false_correct_and_duplicate_ordinals_rejected(client):
    deck_id = demo(client)
    item = client.get(f"/api/decks/{deck_id}/items").json()["items"][0]
    wrong = answer(item, 0, False)
    wrong["correct"] = True
    assert client.post("/api/runs", json=body(deck_id, [wrong])).json()["code"] == "run_invalid"
    correct = answer(item, 0, True)
    assert (
        client.post("/api/runs", json=body(deck_id, [correct, correct])).json()["code"]
        == "run_invalid"
    )


def add_runs(deck_id, finished_at, ids=None):
    """Забеги без ответов, вставленные напрямую: так архив любого размера собирается мгновенно."""
    ids = ids or [f"run-{index:05d}" for index in range(len(finished_at))]
    with session_factory()() as session:
        session.add_all(
            Run(
                id=run_id,
                deck_id=deck_id,
                settings={
                    "lanes": 3,
                    "difficulty": "easy",
                    "filter": "all",
                    "pace": "normal",
                    "lives": None,
                },
                score=index,
                distance=0.0,
                max_streak=0,
                correct_count=0,
                wrong_count=0,
                duration_ms=1000,
                started_at=moment - timedelta(seconds=1),
                finished_at=moment,
            )
            for index, (run_id, moment) in enumerate(zip(ids, finished_at, strict=True))
        )
        session.commit()
    return ids


def run_ids(client, deck_id, query=""):
    response = client.get(f"/api/decks/{deck_id}/runs{query}")
    assert response.status_code == 200, response.text
    return [run["id"] for run in response.json()]


def test_runs_pagination_reads_whole_archive(client):
    deck_id = demo(client)
    start = datetime(2026, 1, 1)
    ids = add_runs(deck_id, [start + timedelta(minutes=n) for n in range(523)])
    newest_first = ids[::-1]

    pages = [run_ids(client, deck_id, f"?limit=500&offset={offset}") for offset in (0, 500, 1000)]
    assert [len(page) for page in pages] == [500, 23, 0]
    assert pages[0] + pages[1] == newest_first

    small = []
    for offset in range(0, 523, 20):
        small += run_ids(client, deck_id, f"?limit=20&offset={offset}")
    assert small == newest_first


def test_runs_default_query_is_backward_compatible(client):
    deck_id = demo(client)
    start = datetime(2026, 1, 1)
    ids = add_runs(deck_id, [start + timedelta(minutes=n) for n in range(25)])
    newest_first = ids[::-1]

    assert run_ids(client, deck_id) == newest_first[:20]
    assert run_ids(client, deck_id, "?limit=20") == run_ids(client, deck_id, "?limit=20&offset=0")
    assert run_ids(client, deck_id, "?limit=3") == newest_first[:3]
    first = client.get(f"/api/decks/{deck_id}/runs?limit=1").json()[0]
    assert set(first) == {
        "id",
        "deck_id",
        "settings",
        "score",
        "distance",
        "max_streak",
        "correct_count",
        "wrong_count",
        "duration_ms",
        "started_at",
        "finished_at",
    }


def test_runs_with_same_finish_time_have_stable_order(client):
    deck_id = demo(client)
    moment = datetime(2026, 5, 5, 12, 0, 0)
    ids = ["run-b", "run-d", "run-a", "run-c", "run-e"]
    add_runs(deck_id, [moment] * len(ids), ids)
    expected = sorted(ids, reverse=True)

    assert run_ids(client, deck_id) == expected
    paged = []
    for offset in range(0, len(ids), 2):
        paged += run_ids(client, deck_id, f"?limit=2&offset={offset}")
    assert paged == expected


def test_runs_empty_page_and_invalid_offset(client):
    deck_id = demo(client)
    assert run_ids(client, deck_id) == []
    add_runs(deck_id, [datetime(2026, 1, 1)])
    assert run_ids(client, deck_id, "?offset=1") == []
    assert run_ids(client, deck_id, "?offset=400&limit=500") == []
    for query in ("?offset=-1", "?offset=abc", "?offset=1.5", "?limit=0&offset=0"):
        response = client.get(f"/api/decks/{deck_id}/runs{query}")
        assert response.status_code == 422, query
    assert client.get("/api/decks/missing/runs?offset=0").status_code == 404


def test_last_run_is_the_list_head_when_finish_times_match(client):
    deck_id = demo(client)
    items = client.get(f"/api/decks/{deck_id}/items").json()["items"]
    first = body(deck_id, [answer(items[0], 0, False), answer(items[1], 1, True)])
    second = body(deck_id, [answer(items[2], 0, False), answer(items[3], 1, True)])
    for request in (first, second):
        assert client.post("/api/runs", json=request).status_code == 201

    head = run_ids(client, deck_id, "?limit=1")[0]
    assert head == max(first["id"], second["id"])
    assert client.get(f"/api/decks/{deck_id}/stats").json()["last_run"]["id"] == head
    mistaken = first if head == first["id"] else second
    last_mistakes = client.get(f"/api/decks/{deck_id}/items?filter=last_mistakes").json()["items"]
    assert [item["id"] for item in last_mistakes] == [mistaken["answers"][0]["item_id"]]
