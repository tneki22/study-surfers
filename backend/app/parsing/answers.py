import re
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from app.parsing.enums import NodeType, ReferenceAnswerMatchMethod
from app.parsing.heading_match import HeadingIndex, HeadingMatch

ANSWER_PREFIX_RE = re.compile(r"^\s*Ответ\s*:\s*(.*)$", re.IGNORECASE)
STUDY_NODE_TYPES = {NodeType.TOPIC, NodeType.SUBPOINT}


@dataclass(frozen=True, slots=True)
class ProgramNodeTitle:
    id: UUID
    title: str


@dataclass(frozen=True, slots=True)
class ParsedAnswerMatch:
    node_id: UUID
    heading: str
    text: str
    method: ReferenceAnswerMatchMethod = ReferenceAnswerMatchMethod.EXACT_TITLE


@dataclass(frozen=True, slots=True)
class ParsedAnswerSection:
    heading: str
    text: str | None
    candidate_node_ids: tuple[UUID, ...] = ()


@dataclass(frozen=True, slots=True)
class ParsedReferenceAnswers:
    matches: tuple[ParsedAnswerMatch, ...]
    ambiguous: tuple[ParsedAnswerSection, ...]
    unmatched_sections: tuple[ParsedAnswerSection, ...]
    empty_sections: tuple[str, ...]


def _answer_text(lines: list[str]) -> str:
    while lines and not lines[0].strip():
        lines.pop(0)
    while lines and not lines[-1].strip():
        lines.pop()
    if lines:
        prefix = ANSWER_PREFIX_RE.match(lines[0])
        if prefix:
            remainder = prefix.group(1).strip()
            lines = ([remainder] if remainder else []) + lines[1:]
    return "\n".join(lines).strip()


def parse_reference_answers(
    raw_text: str,
    study_nodes: Sequence[ProgramNodeTitle],
) -> ParsedReferenceAnswers:
    index = HeadingIndex((node.id, node.title) for node in study_nodes)

    matches: list[ParsedAnswerMatch] = []
    ambiguous: list[ParsedAnswerSection] = []
    unmatched: list[ParsedAnswerSection] = []
    empty: list[str] = []
    leading_lines: list[str] = []
    current_heading: str | None = None
    current_nodes: tuple[UUID, ...] = ()
    current_method = ReferenceAnswerMatchMethod.EXACT_TITLE
    current_lines: list[str] = []

    def flush_current() -> None:
        nonlocal current_heading, current_nodes, current_lines
        if current_heading is None:
            return
        text = _answer_text(current_lines)
        if not text:
            empty.append(current_heading)
        elif len(current_nodes) == 1:
            matches.append(
                ParsedAnswerMatch(
                    node_id=current_nodes[0],
                    heading=current_heading,
                    text=text,
                    method=current_method,
                )
            )
        else:
            ambiguous.append(
                ParsedAnswerSection(
                    heading=current_heading,
                    text=text,
                    candidate_node_ids=current_nodes,
                )
            )
        current_heading = None
        current_nodes = ()
        current_lines = []

    normalized_text = raw_text.replace("\r\n", "\n").replace("\r", "\n")
    for line in normalized_text.split("\n"):
        # Неуверенный подбор здесь не используется: в сплошном тексте отличить
        # заголовок от обычной строки нечем, и предложение кандидатов разрезало бы
        # ответ пополам. Разбор файла (answers_link) знает границы блоков и умеет.
        match = index.match(line) if line.strip() else HeadingMatch()
        if match.matched:
            flush_current()
            current_heading = line.strip()
            current_nodes = match.node_ids
            current_method = match.method or ReferenceAnswerMatchMethod.EXACT_TITLE
            continue
        if current_heading is None:
            leading_lines.append(line)
        else:
            current_lines.append(line)
    flush_current()

    leading_text = _answer_text(leading_lines)
    if leading_text:
        leading_parts = leading_text.splitlines()
        unmatched.append(
            ParsedAnswerSection(
                heading=leading_parts[0],
                text="\n".join(leading_parts[1:]).strip() or None,
            )
        )

    return ParsedReferenceAnswers(
        matches=tuple(matches),
        ambiguous=tuple(ambiguous),
        unmatched_sections=tuple(unmatched),
        empty_sections=tuple(empty),
    )
