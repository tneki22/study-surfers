from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def uid() -> str:
    return str(uuid4())


def utc_now() -> datetime:
    return datetime.now(UTC)


class Deck(Base):
    __tablename__ = "decks"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    title: Mapped[str] = mapped_column(String)
    description: Mapped[str] = mapped_column(Text, default="")
    source_kind: Mapped[str] = mapped_column(String, default="upload")
    tentex_project_id: Mapped[str | None] = mapped_column(String)
    options: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)


class SourceDoc(Base):
    __tablename__ = "source_docs"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    deck_id: Mapped[str] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    filename: Mapped[str] = mapped_column(String)
    kind: Mapped[str] = mapped_column(String)
    role: Mapped[str] = mapped_column(String)
    sha256: Mapped[str] = mapped_column(String)
    text: Mapped[str] = mapped_column(Text)
    blocks: Mapped[list] = mapped_column(JSON, default=list)
    warnings: Mapped[list] = mapped_column(JSON, default=list)


class Question(Base):
    __tablename__ = "questions"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    deck_id: Mapped[str] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    ordinal: Mapped[int] = mapped_column(Integer)
    number_label: Mapped[str] = mapped_column(String, default="")
    section: Mapped[str | None] = mapped_column(String)
    text: Mapped[str] = mapped_column(Text)
    answer_text: Mapped[str | None] = mapped_column(Text)
    answer_doc_id: Mapped[str | None] = mapped_column(
        ForeignKey("source_docs.id", ondelete="SET NULL")
    )
    match_method: Mapped[str] = mapped_column(String, default="none")
    synthetic: Mapped[bool] = mapped_column(Boolean, default=False)
    items_target: Mapped[int | None] = mapped_column(Integer)
    # Главное по теме из программы конспекта: что карточки должны покрыть в первую очередь.
    key_points: Mapped[list | None] = mapped_column(JSON)
    status: Mapped[str] = mapped_column(String, default="pending")
    error: Mapped[str | None] = mapped_column(Text)
    tentex_node_id: Mapped[str | None] = mapped_column(String)


class QuizItem(Base):
    __tablename__ = "quiz_items"
    __table_args__ = (UniqueConstraint("deck_id", "seq"),)
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    deck_id: Mapped[str] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    question_id: Mapped[str | None] = mapped_column(ForeignKey("questions.id", ondelete="SET NULL"))
    seq: Mapped[int] = mapped_column(Integer)
    prompt: Mapped[str] = mapped_column(Text)
    correct: Mapped[str] = mapped_column(Text)
    distractors: Mapped[list] = mapped_column(JSON)
    explanation: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String)
    evidence_quote: Mapped[str | None] = mapped_column(Text)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    edited: Mapped[bool] = mapped_column(Boolean, default=False)
    gen_meta: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)


class GenerationJob(Base):
    __tablename__ = "generation_jobs"
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    deck_id: Mapped[str] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String)
    state: Mapped[str] = mapped_column(String, default="queued")
    done: Mapped[int] = mapped_column(Integer, default=0)
    total: Mapped[int] = mapped_column(Integer, default=0)
    ready_items: Mapped[int] = mapped_column(Integer, default=0)
    warnings: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[dict | None] = mapped_column(JSON)
    estimate: Mapped[dict | None] = mapped_column(JSON)
    usage: Mapped[dict] = mapped_column(
        JSON, default=lambda: {"input_tokens": 0, "output_tokens": 0, "cost_usd": None}
    )
    cancel_requested: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    started_at: Mapped[datetime | None] = mapped_column(DateTime)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime)


class Run(Base):
    __tablename__ = "runs"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    deck_id: Mapped[str] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    settings: Mapped[dict] = mapped_column(JSON)
    score: Mapped[int] = mapped_column(Integer)
    distance: Mapped[float] = mapped_column(Float)
    max_streak: Mapped[int] = mapped_column(Integer)
    correct_count: Mapped[int] = mapped_column(Integer)
    wrong_count: Mapped[int] = mapped_column(Integer)
    duration_ms: Mapped[int] = mapped_column(Integer)
    started_at: Mapped[datetime] = mapped_column(DateTime)
    finished_at: Mapped[datetime] = mapped_column(DateTime)


# Единый порядок «от новых к старым»: при равном времени окончания решает id.
RUN_NEWEST_FIRST = (Run.finished_at.desc(), Run.id.desc())


class RunAnswer(Base):
    __tablename__ = "run_answers"
    __table_args__ = (UniqueConstraint("run_id", "ordinal"),)
    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    run_id: Mapped[str] = mapped_column(ForeignKey("runs.id", ondelete="CASCADE"), index=True)
    item_id: Mapped[str | None] = mapped_column(ForeignKey("quiz_items.id", ondelete="SET NULL"))
    ordinal: Mapped[int] = mapped_column(Integer)
    chosen_text: Mapped[str] = mapped_column(Text)
    chosen_kind: Mapped[str] = mapped_column(String)
    is_correct: Mapped[bool] = mapped_column(Boolean)
    reaction_ms: Mapped[int] = mapped_column(Integer)
    prompt_snapshot: Mapped[dict] = mapped_column(JSON)


class ItemStats(Base):
    __tablename__ = "item_stats"
    item_id: Mapped[str] = mapped_column(
        ForeignKey("quiz_items.id", ondelete="CASCADE"), primary_key=True
    )
    deck_id: Mapped[str] = mapped_column(ForeignKey("decks.id", ondelete="CASCADE"), index=True)
    seen: Mapped[int] = mapped_column(Integer, default=0)
    correct: Mapped[int] = mapped_column(Integer, default=0)
    wrong: Mapped[int] = mapped_column(Integer, default=0)
    streak: Mapped[int] = mapped_column(Integer, default=0)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime)
    last_wrong_at: Mapped[datetime | None] = mapped_column(DateTime)


class AppSetting(Base):
    __tablename__ = "app_settings"
    key: Mapped[str] = mapped_column(String, primary_key=True)
    value: Mapped[dict | str | int] = mapped_column(JSON)
