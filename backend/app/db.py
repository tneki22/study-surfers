import sqlite3
from datetime import UTC, datetime
from functools import lru_cache

from sqlalchemy import create_engine, event
from sqlalchemy.orm import DeclarativeBase, sessionmaker

from app.config import get_settings


class Base(DeclarativeBase):
    pass


SCHEMA_VERSION = 6


@lru_cache
def get_engine():
    folder = get_settings().data_dir
    folder.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        f"sqlite:///{folder / 'study-surfers.sqlite'}",
        connect_args={"check_same_thread": False, "timeout": 30},
    )

    @event.listens_for(engine, "connect")
    def configure(connection, _):
        connection.execute("PRAGMA foreign_keys=ON")
        connection.execute("PRAGMA busy_timeout=30000")
        connection.execute("PRAGMA journal_mode=WAL")

    return engine


def session_factory():
    return sessionmaker(get_engine(), expire_on_commit=False)


def get_session():
    with session_factory()() as session:
        yield session


def _create_schema(connection):
    Base.metadata.create_all(connection)


def _source_blocks(connection):
    columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(source_docs)")}
    if "blocks" not in columns:
        connection.exec_driver_sql(
            "ALTER TABLE source_docs ADD COLUMN blocks JSON NOT NULL DEFAULT '[]'"
        )


def _subscription_connections(connection):
    columns = {
        row[1] for row in connection.exec_driver_sql("PRAGMA table_info(ai_provider_connections)")
    }
    if "executor_kind" not in columns:
        connection.exec_driver_sql(
            "ALTER TABLE ai_provider_connections ADD COLUMN executor_kind TEXT NOT NULL DEFAULT 'api'"
        )


def _question_key_points(connection):
    columns = {row[1] for row in connection.exec_driver_sql("PRAGMA table_info(questions)")}
    if "key_points" not in columns:
        connection.exec_driver_sql("ALTER TABLE questions ADD COLUMN key_points JSON")


MIGRATIONS = [
    _create_schema,
    _create_schema,
    _source_blocks,
    _subscription_connections,
    _create_schema,
    _question_key_points,
]


def init_db():
    engine = get_engine()
    with engine.connect() as connection:
        version = connection.exec_driver_sql("PRAGMA user_version").scalar_one()
    if version > SCHEMA_VERSION:
        raise RuntimeError("База создана более новой версией Study Surfers")
    for target, migration in enumerate(MIGRATIONS, start=1):
        if target <= version:
            continue
        folder = get_settings().data_dir
        backups = folder / "backups"
        backups.mkdir(exist_ok=True)
        stamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%S%fZ")
        with sqlite3.connect(folder / "study-surfers.sqlite") as source:
            with sqlite3.connect(backups / f"schema-{version}-{stamp}.sqlite") as dest:
                source.backup(dest)
        with engine.begin() as connection:
            # SQLite legacy mode не начинает транзакцию для DDL автоматически.
            connection.exec_driver_sql("BEGIN IMMEDIATE")
            migration(connection)
            connection.exec_driver_sql(f"PRAGMA user_version={target}")
        version = target
