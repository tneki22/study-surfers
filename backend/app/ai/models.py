from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Any
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    Numeric,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class AiProviderConnection(Base):
    """Подключение к провайдеру моделей: адрес, профиль каталога и зашифрованный ключ."""

    __tablename__ = "ai_provider_connections"
    __table_args__ = (
        CheckConstraint(
            "catalog_profile IN ('openrouter', 'openai_compatible')",
            name="catalog_profile",
        ),
        UniqueConstraint("label", name="uq_ai_provider_connections_label"),
    )

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    label: Mapped[str] = mapped_column(String)
    catalog_profile: Mapped[str] = mapped_column(String, default="openai_compatible")
    base_url: Mapped[str] = mapped_column(String)
    executor_kind: Mapped[str] = mapped_column(String, default="api")
    api_key_ciphertext: Mapped[bytes | None] = mapped_column(LargeBinary, nullable=True)
    is_favorite: Mapped[bool] = mapped_column(Boolean, default=False)
    last_test_status: Mapped[str | None] = mapped_column(String, nullable=True)
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    last_catalog_refresh_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)


class AiSettings(Base):
    """Единственная строка общих настроек ИИ: лимиты расходов, подтверждение стоимости и курс."""

    __tablename__ = "ai_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="singleton"),
        CheckConstraint("confirm_input_tokens >= 0", name="confirm_tokens_nonnegative"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, default=1)
    external_models_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    daily_limit_usd: Mapped[Decimal | None] = mapped_column(Numeric(24, 12), nullable=True)
    operation_limit_usd: Mapped[Decimal | None] = mapped_column(Numeric(24, 12), nullable=True)
    confirm_cost_usd: Mapped[Decimal | None] = mapped_column(
        Numeric(24, 12), nullable=True, default=Decimal("1.00")
    )
    confirm_input_tokens: Mapped[int] = mapped_column(Integer, default=1_500_000)
    usd_rub_rate: Mapped[Decimal | None] = mapped_column(Numeric(18, 6), nullable=True)
    usd_rub_rate_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    default_text_provider_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("ai_provider_connections.id", ondelete="RESTRICT"),
        nullable=True,
    )
    default_text_model_id: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)


class AiRoleSetting(Base):
    """Настройка роли ИИ: включена ли она и какой моделью переопределена."""

    __tablename__ = "ai_role_settings"

    role: Mapped[str] = mapped_column(String, primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    provider_override_id: Mapped[str | None] = mapped_column(
        String(36),
        ForeignKey("ai_provider_connections.id", ondelete="RESTRICT"),
        nullable=True,
    )
    model_override: Mapped[str | None] = mapped_column(String, nullable=True)
    parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, onupdate=utc_now)


class AiModelCatalogEntry(Base):
    """Модель из каталога провайдера с лимитами контекста и пометкой избранного."""

    __tablename__ = "ai_model_catalog"
    __table_args__ = (
        Index("ix_ai_model_catalog_provider_available", "provider_id", "is_available"),
    )

    provider_id: Mapped[str] = mapped_column(
        String(36),
        ForeignKey("ai_provider_connections.id", ondelete="CASCADE"),
        primary_key=True,
    )
    model_id: Mapped[str] = mapped_column(String, primary_key=True)
    display_name: Mapped[str] = mapped_column(String)
    context_length: Mapped[int | None] = mapped_column(Integer, nullable=True)
    max_completion_tokens: Mapped[int | None] = mapped_column(Integer, nullable=True)
    supported_parameters: Mapped[list[str]] = mapped_column(JSON, default=list)
    input_modalities: Mapped[list[str]] = mapped_column(JSON, default=list)
    output_modalities: Mapped[list[str]] = mapped_column(JSON, default=list)
    reasoning: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    default_parameters: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    manual_overrides: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    prompt_price_usd: Mapped[Decimal | None] = mapped_column(Numeric(24, 12), nullable=True)
    completion_price_usd: Mapped[Decimal | None] = mapped_column(Numeric(24, 12), nullable=True)
    knowledge_cutoff: Mapped[str | None] = mapped_column(String, nullable=True)
    expiration_date: Mapped[str | None] = mapped_column(String, nullable=True)
    pricing_snapshot_at: Mapped[datetime] = mapped_column(DateTime)
    catalog_snapshot_at: Mapped[datetime] = mapped_column(DateTime)
    is_manually_added: Mapped[bool] = mapped_column(Boolean, default=False)
    favorite_order: Mapped[int | None] = mapped_column(Integer, nullable=True)
    is_available: Mapped[bool] = mapped_column(Boolean, default=True)

    structured_mode: Mapped[str | None] = mapped_column(String, nullable=True)


class AiCall(Base):
    __tablename__ = "ai_calls"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    role: Mapped[str] = mapped_column(String)
    provider_id: Mapped[str | None] = mapped_column(
        String(36), ForeignKey("ai_provider_connections.id", ondelete="SET NULL"), nullable=True
    )
    model_id: Mapped[str] = mapped_column(String)
    status: Mapped[str] = mapped_column(String)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[Decimal | None] = mapped_column(Numeric(24, 12), nullable=True)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    job_id: Mapped[str | None] = mapped_column(String(36), nullable=True, index=True)
    error_code: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utc_now, index=True)
