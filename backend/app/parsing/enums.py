from enum import StrEnum


class ExamFormat(StrEnum):
    QUESTIONS = "questions"
    QUESTIONS_TASKS = "questions_tasks"
    TICKETS = "tickets"
    UNKNOWN = "unknown"


class ExamKind(StrEnum):
    QUESTION = "question"
    TASK = "task"
    TICKET = "ticket"


class NodeType(StrEnum):
    SECTION = "section"
    TOPIC = "topic"
    SUBPOINT = "subpoint"


class ReferenceAnswerMatchMethod(StrEnum):
    EXACT_TITLE = "exact_title"
    FUZZY_TITLE = "fuzzy_title"
    NUMBERED_ORDER = "numbered_order"
    AI_SECTION = "ai_section"
