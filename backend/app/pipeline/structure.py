"""Вопросы и дословные ответы из извлечённых учебных документов."""

import asyncio
import json
import re
from dataclasses import dataclass, field
from typing import Literal
from urllib.parse import urlsplit
from uuid import UUID, uuid4

from pydantic import BaseModel, ConfigDict, Field

from app.ai.settings import is_local_model_host
from app.parsing.answers import ProgramNodeTitle, _answer_text, parse_reference_answers
from app.parsing.classify import classify_documents
from app.parsing.enums import ExamFormat, NodeType
from app.parsing.extract import ExtractedDocument
from app.parsing.heading_match import HeadingIndex, normalize_answer_heading
from app.parsing.importer import ExamImportError, parse_exam_program
from app.parsing.numbered_series import select_numbered_series
from app.parsing.prompts import (
    ANSWER_SECTIONS_SYSTEM_PROMPT,
    PROGRAM_SYSTEM_PROMPT,
    REPAIR_SYSTEM_PROMPT,
    outline_prompt,
)
from app.parsing.skeleton import batch_skeleton_lines, build_skeleton, format_skeleton_line


@dataclass(slots=True)
class StructuredQuestion:
    ordinal: int
    number_label: str
    text: str
    section: str | None = None
    answer_text: str | None = None
    answer_doc_id: str | None = None
    match_method: str = "none"
    synthetic: bool = False
    key_points: list[str] = field(default_factory=list)
    id: str = field(default_factory=lambda: str(uuid4()))

    @property
    def title(self) -> str:
        return self.text


class RepairWireItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["question", "task", "ticket"]
    title: str
    subpoints: list[str]
    source_indices: list[int]
    ticket_index: int


class DroppedWireItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    source_indices: list[int]
    reason: str


class RepairWireSuggestion(BaseModel):
    model_config = ConfigDict(extra="forbid")
    items: list[RepairWireItem]
    dropped: list[DroppedWireItem]
    changes: list[str]
    warnings: list[str]


class AnswerBoundaryWire(BaseModel):
    model_config = ConfigDict(extra="forbid")
    candidate: int = Field(ge=0)
    question: int = Field(ge=0)
    confidence: Literal["high", "low"]
    note: str


class AnswerSectionsWire(BaseModel):
    model_config = ConfigDict(extra="forbid")
    boundaries: list[AnswerBoundaryWire]
    skipped_questions: list[int]


class OutlineQuestionWire(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: int = Field(ge=0)
    question: str
    section: str
    key_points: list[str]


class OutlineSkipWire(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: int = Field(ge=0)
    end: int = Field(ge=0)


class OutlineWire(BaseModel):
    model_config = ConfigDict(extra="forbid")
    questions: list[OutlineQuestionWire]
    skip: list[OutlineSkipWire]


class ProgramTopicWire(BaseModel):
    model_config = ConfigDict(extra="forbid")
    start: int = Field(ge=0)
    merge: bool
    question: str
    section: str


class ProgramWire(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topics: list[ProgramTopicWire]


OUTLINE_LINE_CHARS = 200
KEY_POINTS_MAX = 6


def _key_points(points: list[str]) -> list[str]:
    return [" ".join(p.split())[:160] for p in points if p.strip()][:KEY_POINTS_MAX]


@dataclass(slots=True)
class _Section:
    heading: str
    body: str
    start: int
    end: int
    question: int = 0


def _chunks(text: str, limit: int = 12000) -> list[str]:
    """Режем на границе строки; огромную строку делим по пробелу."""
    chunks = []
    while len(text) > limit:
        headings = list(
            re.finditer(r"(?m)^\s*(?:#{1,6}\s|\d+[.)]\s|(?:Вопрос|Билет)\s+)", text[:limit])
        )
        end = (
            headings[-1].start()
            if headings and headings[-1].start() >= limit // 2
            else text.rfind("\n", 0, limit)
        )
        if end <= 0:
            end = text.rfind(" ", 0, limit)
        end = end if end > 0 else limit
        chunks.append(text[:end])
        text = text[end:].lstrip("\n")
    if text.strip():
        chunks.append(text)
    return chunks


def _local_client(client) -> bool:
    if not hasattr(client, "resolve"):
        return False
    resolved = client.resolve("extract")
    return is_local_model_host(urlsplit(resolved.provider.base_url).hostname or "")


async def _repair_questions(text: str, client) -> list[StructuredQuestion]:
    lines = [line for line in text.splitlines() if line.strip()]
    result = await client.complete(
        role="extract",
        response_model=RepairWireSuggestion,
        messages=[
            {
                "role": "system",
                "content": REPAIR_SYSTEM_PROMPT
                + "\nВерни плоские items: ticket_index=0 вне билета. source_indices — номера непустых строк входа от 1.",
            },
            {
                "role": "user",
                "content": "<numbered_list>"
                + json.dumps(dict(enumerate(lines, 1)), ensure_ascii=False)
                + "</numbered_list>",
            },
        ],
    )
    allowed = set(range(1, len(lines) + 1))
    used = set()
    output = []
    tickets = {
        index: item.title for index, item in enumerate(result.items, 1) if item.kind == "ticket"
    }
    for item in result.items:
        if not item.source_indices or not set(item.source_indices) <= allowed:
            raise ValueError("Модель вернула вопрос без подтверждённых исходных строк")
        used.update(item.source_indices)
        if item.kind == "ticket":
            continue
        title = item.title.strip()
        if title:
            output.append(
                StructuredQuestion(
                    len(output) + 1,
                    str(len(output) + 1),
                    title + ("\n" + "\n".join(item.subpoints) if item.subpoints else ""),
                    tickets.get(item.ticket_index),
                )
            )
    dropped = {i for item in result.dropped for i in item.source_indices}
    if used & dropped or used | dropped != allowed:
        raise ValueError("Модель потеряла строки при восстановлении вопросов")
    return output


async def _questions(document: ExtractedDocument, client) -> list[StructuredQuestion]:
    text = re.sub(
        r"(?im)^\s*(?:Вопрос|Задача)\s*(?:№\s*)?(\d+)\s*[.):]?\s+", r"\1. ", document.text
    )
    fmt = (
        ExamFormat.TICKETS
        if re.search(r"(?im)^\s*Билет\s*(?:№\s*)?\d+", text)
        else ExamFormat.QUESTIONS
    )
    lines = [line.strip() for line in text.splitlines() if line.strip()]
    selection = select_numbered_series(lines)
    try:
        parsed = parse_exam_program(text, fmt)
        topics = [n for n in parsed.nodes if n.node_type == NodeType.TOPIC]
        unreliable = (
            len(topics) < 3
            or selection.ambiguous
            or (fmt == ExamFormat.QUESTIONS and not selection.items)
        )
    except ExamImportError:
        parsed, unreliable = None, True
    if unreliable and client is not None:
        batches = await asyncio.gather(
            *(
                _repair_questions(chunk, client)
                for chunk in _chunks(text, 6000 if _local_client(client) else 12000)
            )
        )
        return [question for batch in batches for question in batch]
    if parsed is None:
        return []
    output = []
    for index, node in enumerate(parsed.nodes):
        if node.node_type != NodeType.TOPIC:
            continue
        children = [
            n.title
            for n in parsed.nodes
            if n.parent_index == index and n.node_type == NodeType.SUBPOINT
        ]
        parent = parsed.nodes[node.parent_index] if node.parent_index is not None else None
        number = (
            str(selection.items[len(output)].number)
            if len(output) < len(selection.items)
            else str(len(output) + 1)
        )
        output.append(
            StructuredQuestion(
                len(output) + 1,
                number,
                node.title + ("\n" + "\n".join(children) if children else ""),
                parent.title if parent else None,
            )
        )
    return output


def _sections(document: ExtractedDocument, questions: list[StructuredQuestion]) -> list[_Section]:
    index = HeadingIndex((UUID(q.id), q.text) for q in questions)
    starts = []
    for position, block in enumerate(document.blocks):
        if index.match(block.text).matched or block.kind == "heading":
            starts.append(position)
        elif (
            block.kind == "list" and re.match(r"^\d+[.)]\s", block.text) and len(block.text) <= 200
        ):
            starts.append(position)
    sections = []
    for start, end in zip(starts, [*starts[1:], len(document.blocks)]):
        body = _answer_text([b.text for b in document.blocks[start + 1 : end]])
        if body:
            sections.append(_Section(document.blocks[start].text, body, start, end))
    return sections


async def _ai_sections(
    document: ExtractedDocument, questions: list[StructuredQuestion], client
) -> list[_Section]:
    nodes = [ProgramNodeTitle(UUID(q.id), q.text) for q in questions]
    skeleton = build_skeleton(nodes, [(b, b.page) for b in document.blocks])
    if not skeleton.lines:
        return []

    local = _local_client(client)
    question_groups = (
        [
            {
                index + 1: q.text[:140]
                for index, q in enumerate(questions)
                if start <= index < start + 24
            }
            for start in range(0, len(questions), 24)
        ]
        if local
        else [[q.text for q in questions]]
    )

    async def mark(batch, question_group):
        result = await client.complete(
            role="extract",
            response_model=AnswerSectionsWire,
            messages=[
                {
                    "role": "system",
                    "content": ANSWER_SECTIONS_SYSTEM_PROMPT
                    + (
                        "\nquestions — объект с исходными номерами вопросов в ключах. Верни эти номера, а не позиции в пакете."
                        if local
                        else ""
                    ),
                },
                {
                    "role": "user",
                    "content": json.dumps(
                        {
                            "questions": question_group,
                            "skeleton": [format_skeleton_line(line) for line in batch],
                        },
                        ensure_ascii=False,
                    ),
                },
            ],
        )
        indices = {line.index for line in batch}
        return [
            boundary
            for boundary in result.boundaries
            if boundary.candidate in indices
            and boundary.question <= len(questions)
            and (not local or boundary.question == 0 or boundary.question in question_group)
        ]

    skeleton_batches = (
        batch_skeleton_lines(skeleton.lines, max_lines=18, max_bytes=3000)
        if local
        else batch_skeleton_lines(skeleton.lines)
    )
    batches = await asyncio.gather(
        *(mark(batch, group) for batch in skeleton_batches for group in question_groups)
    )
    boundaries = {}

    def priority(value):
        return (value.question > 0, value.confidence == "high")

    for batch in batches:
        for boundary in batch:
            current = boundaries.get(boundary.candidate)
            if current is None or priority(boundary) > priority(current):
                boundaries[boundary.candidate] = boundary
    positions = {block.id: position for position, block in enumerate(document.blocks)}
    ordered = sorted(boundaries)
    sections = []
    for offset, candidate in enumerate(ordered):
        line = skeleton.lines[candidate]
        start = positions[line.fragment_id]
        end = (
            positions[skeleton.lines[ordered[offset + 1]].fragment_id]
            if offset + 1 < len(ordered)
            else len(document.blocks)
        )
        body = _answer_text([b.text for b in document.blocks[start + 1 : end]])
        if body:
            sections.append(
                _Section(
                    document.blocks[start].text, body, start, end, boundaries[candidate].question
                )
            )
    return sections


def _outline_parts(blocks, budget: int) -> list[list[tuple[int, str]]]:
    """Строки документа частями для модели; длинные строки обрезаются, номера глобальные."""
    parts, current, size = [], [], 0
    for index, block in enumerate(blocks):
        text = " ".join(block.text.split())[:OUTLINE_LINE_CHARS]
        if not text:
            continue
        if current and size + len(text) > budget:
            parts.append(current)
            current, size = [], 0
        current.append((index, text))
        size += len(text) + 8
    if current:
        parts.append(current)
    return parts


async def _ai_outline(
    document: ExtractedDocument, client, synthetic: bool, learner_prompt: str | None = None
) -> list[StructuredQuestion]:
    """Вопросы по материалу без надёжной структуры: границы и формулировки решает модель.

    Модель видит пронумерованные строки и возвращает только номера строк начала вопросов;
    текст ответа сервер собирает сам, дословно, между соседними границами.
    """
    parts = _outline_parts(document.blocks, 8000 if _local_client(client) else 30000)
    system = outline_prompt(learner_prompt)

    async def outline(number, part):
        return await client.complete(
            role="extract",
            response_model=OutlineWire,
            messages=[
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": json.dumps(
                        {"part": number, "parts": len(parts), "lines": dict(part)},
                        ensure_ascii=False,
                    ),
                },
            ],
        )

    results = await asyncio.gather(*(outline(n, p) for n, p in enumerate(parts, 1)))
    starts: dict[int, tuple[str, str | None, list[str]]] = {}
    skipped: set[int] = set()
    last_title = None
    for result, part in zip(results, parts, strict=True):
        indices = [index for index, _ in part]
        allowed = set(indices)
        for skip in result.skip:
            skipped.update(i for i in indices if skip.start <= i <= skip.end)
        for item in sorted(result.questions, key=lambda q: q.start):
            title = " ".join(item.question.split())[:300]
            if item.start not in allowed or item.start in starts or not title:
                continue
            # Параллельные части не видят друг друга: тема на стыке может прийти дважды.
            if (
                item.start == indices[0]
                and last_title
                and normalize_answer_heading(title) == normalize_answer_heading(last_title)
            ):
                continue
            starts[item.start] = (
                title,
                " ".join(item.section.split())[:200] or None,
                _key_points(item.key_points),
            )
        if starts:
            last_title = starts[max(starts)][0]
    if len(parts) > 1 and len(starts) > 1:
        starts = await _review_program(starts, client)
    ordered = sorted(starts)
    skipped -= set(ordered)
    questions = []
    section = None
    for offset, start in enumerate(ordered):
        # Материал до первого вопроса (если он не служебный) относится к первому вопросу.
        begin = 0 if offset == 0 else start
        end = ordered[offset + 1] if offset + 1 < len(ordered) else len(document.blocks)
        body = _answer_text(
            [b.text for i, b in enumerate(document.blocks[begin:end], begin) if i not in skipped]
        )
        if not body:
            continue
        # Части размечаются параллельно: раздел из заголовка модуля переходит на следующие вопросы.
        title, section = starts[start][0], starts[start][1] or section
        questions.append(
            StructuredQuestion(
                0,
                "",
                title,
                section,
                answer_text=body,
                answer_doc_id=document.id,
                match_method="ai_outline",
                synthetic=synthetic,
                key_points=starts[start][2],
            )
        )
    return questions


async def _review_program(
    starts: dict[int, tuple[str, str | None, list[str]]], client
) -> dict[int, tuple[str, str | None, list[str]]]:
    """Сводит темы параллельно размеченных частей в одну программу.

    Модель видит только список тем: сливает дубли на стыках и выравнивает разделы.
    Ответ, который теряет или добавляет темы, отбрасывается — остаётся разметка по частям.
    """
    ordered = sorted(starts)
    local = _local_client(client)
    topics = [
        {"start": start, "question": title, "section": section or ""}
        | ({} if local else {"key_points": points})
        for start, (title, section, points) in sorted(starts.items())
    ]
    result = await client.complete(
        role="extract",
        response_model=ProgramWire,
        messages=[
            {"role": "system", "content": PROGRAM_SYSTEM_PROMPT},
            {"role": "user", "content": json.dumps({"topics": topics}, ensure_ascii=False)},
        ],
    )
    if [topic.start for topic in result.topics] != ordered:
        return starts
    program: dict[int, tuple[str, str | None, list[str]]] = {}
    last = None
    for topic in result.topics:
        title = " ".join(topic.question.split())[:300] or starts[topic.start][0]
        section = " ".join(topic.section.split())[:200] or None
        if topic.merge and last is not None:
            previous = program[last]
            program[last] = (
                title,
                previous[1] or section,
                (previous[2] + starts[topic.start][2])[:KEY_POINTS_MAX],
            )
            continue
        program[topic.start] = (title, section, starts[topic.start][2])
        last = topic.start
    return program


def _synthetic(
    section: _Section, document: ExtractedDocument, method: str = "combined"
) -> StructuredQuestion:
    title = re.sub(r"^\s*#{1,6}\s*", "", section.heading)
    title = re.sub(r"^\s*\d+[.)]\s*", "", title).strip()
    return StructuredQuestion(
        0,
        "",
        title or "Материал для повторения",
        answer_text=section.body,
        answer_doc_id=document.id,
        match_method=method,
        synthetic=True,
    )


async def structure_documents(
    documents: list[ExtractedDocument], ai_client=None, learner_prompt: str | None = None
) -> list[StructuredQuestion]:
    await classify_documents(documents, ai_client=ai_client)
    questions = []
    for document in documents:
        if document.role == "questions":
            questions.extend(await _questions(document, ai_client))
    question_nodes = [ProgramNodeTitle(UUID(q.id), q.text) for q in questions]
    by_id = {UUID(q.id): q for q in questions}
    for document in documents:
        if document.role not in {"answers", "notes", "combined"}:
            continue
        # Без списка вопросов число и границы вопросов определяет модель, а не заголовки:
        # в конспектах и исходниках Typst/LaTeX заголовки ненадёжны.
        if ai_client is not None and (document.role != "answers" or not question_nodes):
            outlined = await _ai_outline(
                document, ai_client, document.role != "combined", learner_prompt
            )
            if outlined:
                questions.extend(outlined)
                continue
        sections = _sections(document, questions)
        # Большая преамбула тоже материал: сохраняем её отдельными вопросами.
        if sections and sections[0].start > 0:
            leading = "\n".join(
                block.text for block in document.blocks[: sections[0].start]
            ).strip()
            if len(leading) >= 300:
                questions.extend(
                    _synthetic(
                        _Section(f"{document.filename}: введение {i + 1}", chunk, 0, 0), document
                    )
                    for i, chunk in enumerate(_chunks(leading, 2500))
                )
        if document.role in {"notes", "combined"}:
            if not sections:
                sections = [
                    _Section(f"{document.filename}: часть {i + 1}", chunk, 0, 0)
                    for i, chunk in enumerate(_chunks(document.text, 2500))
                ]
            for section in sections:
                question = _synthetic(section, document)
                question.synthetic = document.role == "notes"
                questions.append(question)
            continue
        matched_sections = set()
        for section in sections:
            # Не даём соседнему неизвестному разделу попасть в точный ответ.
            parsed = parse_reference_answers(section.heading + "\n" + section.body, question_nodes)
            for match in parsed.matches:
                question = by_id[match.node_id]
                if question.answer_text is None:
                    question.answer_text, question.answer_doc_id = match.text, document.id
                    question.match_method = (
                        "exact" if match.method.value == "exact_title" else "fuzzy"
                    )
                matched_sections.add(section.start)
        coverage = sum(q.answer_text is not None for q in by_id.values()) / max(1, len(by_id))
        if coverage < 0.6 and len(sections) == len(question_nodes):
            for question, section in zip(by_id.values(), sections, strict=True):
                if question.answer_text is None and section.start not in matched_sections:
                    question.answer_text, question.answer_doc_id, question.match_method = (
                        section.body,
                        document.id,
                        "numbered_order",
                    )
                    matched_sections.add(section.start)
        coverage = sum(q.answer_text is not None for q in by_id.values()) / max(1, len(by_id))
        if coverage < 0.6 and ai_client is not None:
            ai_sections = await _ai_sections(document, list(by_id.values()), ai_client)
            if ai_sections:
                sections = ai_sections
                matched_sections = set()
                for section in sections:
                    if section.question:
                        question = list(by_id.values())[section.question - 1]
                        if question.answer_text is None:
                            question.answer_text, question.answer_doc_id, question.match_method = (
                                section.body,
                                document.id,
                                "ai_section",
                            )
                        matched_sections.add(section.start)
                    elif any(
                        q.answer_text
                        and normalize_answer_heading(section.heading)
                        == normalize_answer_heading(q.text)
                        for q in by_id.values()
                    ):
                        matched_sections.add(section.start)
        for section in sections:
            if section.start not in matched_sections and len(section.body) >= 300:
                questions.append(_synthetic(section, document))
        if not sections and len(document.text.strip()) >= 300:
            questions.extend(
                _synthetic(_Section(f"{document.filename}: часть {i + 1}", chunk, 0, 0), document)
                for i, chunk in enumerate(_chunks(document.text, 2500))
            )
    for ordinal, question in enumerate(questions, 1):
        question.ordinal = ordinal
        question.number_label = question.number_label or str(ordinal)
    return questions
