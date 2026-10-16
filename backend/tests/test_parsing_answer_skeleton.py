from uuid import uuid4

from app.parsing.answers import ProgramNodeTitle
from app.parsing.extract import Block
from app.parsing.skeleton import (
    Skeleton,
    batch_skeleton_lines,
    build_skeleton,
    format_skeleton_line,
)


def _nodes(titles):
    return [ProgramNodeTitle(uuid4(), title) for title in titles]


def _fragment(text, order, kind="paragraph"):
    return Block(id=uuid4(), text=text, element_kind=kind, page=1)


def test_heading_fragment_is_always_a_candidate() -> None:
    nodes = _nodes(["Транзакции и блокировки"])
    heading = _fragment("Что-то не похожее на формулировку вопроса", 0, "heading")
    body = _fragment("Ответ на первый вопрос.", 1)
    rows = [(heading, 1), (body, 1)]

    skeleton = build_skeleton(nodes, rows)

    assert [line.fragment_id for line in skeleton.lines] == [heading.id]
    assert skeleton.lines[0].chars_to_next == len(body.text)


def test_internal_numbered_item_without_page_start_is_not_a_candidate() -> None:
    nodes = _nodes(["Транзакции и блокировки"])
    heading = _fragment("Транзакции и блокировки", 0, "heading")
    internal = _fragment("1) первый пункт списка внутри ответа", 1, "list")
    body = _fragment("Продолжение ответа после списка.", 2)
    rows = [(heading, 1), (internal, 1), (body, 1)]

    skeleton = build_skeleton(nodes, rows)

    assert [line.fragment_id for line in skeleton.lines] == [heading.id]
    assert skeleton.lines[0].chars_to_next == len(internal.text) + len(body.text)


def test_marker_at_page_start_is_a_candidate_even_without_heading_kind() -> None:
    nodes = _nodes(["Транзакции и блокировки", "Индексы и планы выполнения"])
    first_body = _fragment("Текст пояснения без общих слов с заголовками.", 0)
    second_header = _fragment("2. Индексы и планы выполнения", 1, "paragraph")
    rows = [(first_body, 1), (second_header, 2)]

    skeleton = build_skeleton(nodes, rows)

    assert [line.fragment_id for line in skeleton.lines] == [second_header.id]


def test_lexical_match_makes_a_candidate_without_marker_or_heading_kind() -> None:
    nodes = _nodes(["Транзакции и блокировки в реляционных базах данных"])
    header = _fragment("Транзакции и блокировки в реляционных базах данных", 0, "paragraph")
    body = _fragment("Тело ответа.", 1)
    rows = [(header, 1), (body, 1)]

    skeleton = build_skeleton(nodes, rows)

    assert [line.fragment_id for line in skeleton.lines] == [header.id]
    assert skeleton.lines[0].hints
    assert skeleton.lines[0].hints[0].question == 1


def test_source_hash_is_stable_and_changes_with_content() -> None:
    nodes = _nodes(["Вопрос один"])
    rows = [(_fragment("Вопрос один", 0, "heading"), 1)]

    first = build_skeleton(nodes, rows)
    second = build_skeleton(nodes, rows)
    assert first.source_hash == second.source_hash

    other_rows = [(_fragment("Вопрос один изменённый", 0, "heading"), 1)]
    changed = build_skeleton(nodes, other_rows)
    assert changed.source_hash != first.source_hash


def test_format_skeleton_line_matches_expected_shape() -> None:
    nodes = _nodes(["Вопрос один", "Вопрос два"])
    heading = _fragment("2. Вопрос два", 0, "heading")
    rows = [(heading, 5)]

    skeleton = build_skeleton(nodes, rows)
    rendered = format_skeleton_line(skeleton.lines[0])

    assert rendered.startswith("#0 p5 head ")
    assert '"2. Вопрос два"' in rendered
    assert rendered.endswith("0ch ->2:1.00")


def test_batch_skeleton_lines_respects_line_limit_and_overlaps() -> None:
    nodes = _nodes([f"Вопрос {number}" for number in range(1, 6)])
    rows = [
        (_fragment(f"{number}. Вопрос {number}", index, "heading"), number)
        for index, number in enumerate(range(1, 6))
    ]
    skeleton = build_skeleton(nodes, rows)

    batches = batch_skeleton_lines(skeleton.lines, max_lines=2, max_bytes=24_000, overlap=1)

    assert [line.index for line in batches[0]] == [0, 1]
    assert [line.index for line in batches[1]] == [1, 2]
    assert [line.index for line in batches[2]] == [2, 3]
    assert [line.index for line in batches[3]] == [3, 4]


def test_empty_skeleton_batches_to_nothing() -> None:
    empty = Skeleton(lines=(), source_hash="ignored")
    assert batch_skeleton_lines(empty.lines) == []
