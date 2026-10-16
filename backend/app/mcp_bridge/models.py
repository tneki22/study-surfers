from datetime import datetime

from sqlalchemy import JSON, ForeignKey, Integer, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models import uid, utc_now


class ExternalTask(Base):
    __tablename__ = "external_tasks"
    __table_args__ = (UniqueConstraint("job_id", "request_key"),)

    id: Mapped[str] = mapped_column(String, primary_key=True, default=uid)
    job_id: Mapped[str] = mapped_column(
        ForeignKey("generation_jobs.id", ondelete="CASCADE"), index=True
    )
    request_key: Mapped[str] = mapped_column(String)
    payload: Mapped[dict] = mapped_column(JSON)
    state: Mapped[str] = mapped_column(String, default="pending", index=True)
    version: Mapped[int] = mapped_column(Integer, default=0)
    lease_token: Mapped[str | None] = mapped_column(String, nullable=True)
    lease_expires_at: Mapped[datetime | None] = mapped_column(nullable=True)
    result: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    actual_model: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(default=utc_now)
