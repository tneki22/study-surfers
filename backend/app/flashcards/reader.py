"""Чтение флеш-карточек чужих сервисов: пакеты Anki и текстовые таблицы (Anki, Quizlet, CSV).

Результат — заметки с полями как есть: какое поле вопрос, а какое ответ, решает мастер импорта.
"""

import csv
import html
import io
import json
import re
import sqlite3
import tempfile
import zipfile
from dataclasses import dataclass, field
from itertools import islice
from pathlib import Path

import zstandard
from charset_normalizer import from_bytes

from app.core.errors import DomainError

MAX_NOTES = 20_000
MAX_COLLECTION_BYTES = 128 * 1024 * 1024
MAX_METADATA_ROWS = 20_000
MAX_CARD_ROWS = 100_000


@dataclass
class NoteType:
    id: str
    name: str
    fields: list[str]
    count: int = 0
    cloze: bool = False


@dataclass
class Note:
    id: str
    note_type: str
    fields: list[str]
    deck: str | None = None
    tags: list[str] = field(default_factory=list)


@dataclass
class FlashcardSource:
    format: str
    note_types: dict[str, NoteType]
    notes: list[Note]
    decks: dict[str, int]
    title: str | None = None


def invalid(detail: str) -> DomainError:
    return DomainError(422, "flashcards_file_invalid", detail)


# --- Поля Anki: HTML, медиа, формулы, пропуски ---

CLOZE = re.compile(r"\{\{c(\d+)::(.*?)(?:::(.*?))?\}\}", re.S)
MEDIA = re.compile(r"\[sound:[^\]]*\]|<img\b[^>]*>|<(audio|video)\b.*?</\1>", re.I | re.S)


def clean_field(value: str, *, is_html: bool = True) -> str:
    """HTML поля → обычный текст: переносы сохраняются, медиа и разметка убираются.

    Формулы MathJax Anki `\\(...\\)` и `\\[...\\]` становятся `$...$`, как в карточках игры.
    """
    text = value.replace("\r\n", "\n")
    text = MEDIA.sub(" ", text)
    if is_html:
        text = re.sub(r"<br\s*/?>|</(div|p|li|tr|h\d)>", "\n", text, flags=re.I)
        text = re.sub(r"<li\b[^>]*>", "• ", text, flags=re.I)
        text = re.sub(r"<(style|script)\b.*?</\1>", "", text, flags=re.I | re.S)
        text = re.sub(r"<[^>]+>", "", text)
        text = html.unescape(text)
    text = re.sub(r"\\\((.+?)\\\)|\\\[(.+?)\\\]", lambda m: f"${m[1] or m[2]}$", text, flags=re.S)
    text = text.replace("\xa0", " ")
    lines = [re.sub(r"[ \t]+", " ", line).strip() for line in text.split("\n")]
    return "\n".join(line for line in lines if line)


def has_media(value: str) -> bool:
    return bool(MEDIA.search(value))


def is_cloze(value: str) -> bool:
    return bool(CLOZE.search(value))


# --- Пакеты Anki ---


def _collection(archive: zipfile.ZipFile, folder: Path) -> Path:
    names = set(archive.namelist())
    # Новые версии кладут настоящую базу в anki21b (zstd), а в anki2 — заглушку «обновите Anki».
    if "collection.anki21b" in names:
        _check_member(archive, "collection.anki21b")
        target = folder / "collection.sqlite"
        with archive.open("collection.anki21b") as source, target.open("wb") as output:
            with zstandard.ZstdDecompressor(max_window_size=64 * 1024 * 1024).stream_reader(
                source
            ) as reader:
                _copy_collection(reader, output)
        return target
    for name in ("collection.anki21", "collection.anki2"):
        if name in names:
            _check_member(archive, name)
            target = folder / "collection.sqlite"
            with archive.open(name) as source, target.open("wb") as output:
                _copy_collection(source, output)
            return target
    raise invalid("В архиве нет коллекции Anki: это точно файл .apkg или .colpkg?")


def _check_member(archive, name):
    if archive.getinfo(name).file_size > MAX_COLLECTION_BYTES:
        raise DomainError(413, "import_too_large", "Коллекция Anki слишком велика после распаковки")


def _copy_collection(source, output):
    total = 0
    while chunk := source.read(min(64 * 1024, MAX_COLLECTION_BYTES - total + 1)):
        total += len(chunk)
        if total > MAX_COLLECTION_BYTES:
            raise DomainError(
                413, "import_too_large", "Коллекция Anki слишком велика после распаковки"
            )
        output.write(chunk)


def _rows(connection, query, limit=MAX_METADATA_ROWS):
    rows = connection.execute(query).fetchmany(limit + 1)
    if len(rows) > limit:
        raise DomainError(
            422,
            "flashcards_too_many",
            "В коллекции слишком много записей. Экспортируйте одну колоду.",
        )
    return rows


def _tables(connection) -> set[str]:
    return {
        row[0] for row in _rows(connection, "SELECT name FROM sqlite_master WHERE type='table'")
    }


def _legacy_schema(connection):
    """Схема 11: типы заметок и колоды лежат JSON-ом в таблице col."""
    models_raw, decks_raw = connection.execute("SELECT models, decks FROM col").fetchone()
    models = json.loads(models_raw or "{}")
    decks = json.loads(decks_raw or "{}")
    if len(models) > MAX_METADATA_ROWS or len(decks) > MAX_METADATA_ROWS:
        raise DomainError(422, "flashcards_too_many", "В коллекции слишком много типов или колод")
    note_types = {
        str(mid): NoteType(
            id=str(mid),
            name=model.get("name") or "Тип заметок",
            fields=[f["name"] for f in sorted(model.get("flds", []), key=lambda f: f["ord"])],
            cloze=model.get("type") == 1,
        )
        for mid, model in models.items()
    }
    deck_names = {str(did): deck.get("name", "") for did, deck in decks.items()}
    return note_types, deck_names


def _modern_schema(connection):
    """Схема 18: отдельные таблицы notetypes, fields и decks; иерархия колод через \\x1f."""
    note_types = {
        str(ntid): NoteType(id=str(ntid), name=name, fields=[])
        for ntid, name in _rows(connection, "SELECT id, name FROM notetypes")
    }
    for ntid, name in _rows(connection, "SELECT ntid, name FROM fields ORDER BY ntid, ord"):
        if str(ntid) in note_types:
            note_types[str(ntid)].fields.append(name)
    deck_names = {
        str(did): name.replace("\x1f", "::")
        for did, name in _rows(connection, "SELECT id, name FROM decks")
    }
    return note_types, deck_names


def read_package(data: bytes, filename: str) -> FlashcardSource:
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise invalid("Файл повреждён или это не пакет Anki") from exc
    with tempfile.TemporaryDirectory(prefix="ss-anki-") as folder, archive:
        path = _collection(archive, Path(folder))
        connection = sqlite3.connect(path)
        connection.setlimit(sqlite3.SQLITE_LIMIT_LENGTH, 2 * 1024 * 1024)
        try:
            tables = _tables(connection)
            if "notes" not in tables:
                raise invalid("В коллекции Anki нет заметок")
            if {"notetypes", "fields", "decks"} <= tables:
                note_types, deck_names = _modern_schema(connection)
            else:
                note_types, deck_names = _legacy_schema(connection)
            # Колода заметки — колода её первой карточки (у SQLite голые столбцы берутся из строки MIN).
            note_decks = {
                str(nid): str(did)
                for nid, did, _ in _rows(
                    connection, "SELECT nid, did, MIN(ord) FROM cards GROUP BY nid", MAX_CARD_ROWS
                )
            }
            rows = _rows(connection, "SELECT id, mid, flds, tags FROM notes ORDER BY id", MAX_NOTES)
        except sqlite3.DatabaseError as exc:
            raise invalid("Коллекция Anki повреждена или в незнакомом формате") from exc
        finally:
            connection.close()
    if len(rows) > MAX_NOTES:
        raise DomainError(
            422,
            "flashcards_too_many",
            f"В файле больше {MAX_NOTES} заметок: экспортируйте из Anki одну колоду",
        )
    notes = []
    decks: dict[str, int] = {}
    for nid, mid, flds, tags in rows:
        note_type = note_types.get(str(mid))
        if note_type is None:
            note_type = note_types[str(mid)] = NoteType(id=str(mid), name="Тип заметок", fields=[])
        values = flds.split("\x1f")
        while len(note_type.fields) < len(values):
            note_type.fields.append(f"Поле {len(note_type.fields) + 1}")
        deck = deck_names.get(note_decks.get(str(nid), ""))
        note_type.count += 1
        note_type.cloze = note_type.cloze or any(is_cloze(v) for v in values)
        if deck:
            decks[deck] = decks.get(deck, 0) + 1
        notes.append(
            Note(id=str(nid), note_type=str(mid), fields=values, deck=deck, tags=tags.split())
        )
    # Заглушка старого формата: единственная заметка «обновите Anki» без колоды.
    if len(notes) == 1 and "update to the latest anki" in notes[0].fields[0].casefold():
        raise invalid("Пакет сохранён новой Anki в формате, который не удалось прочитать")
    used = {n.note_type for n in notes}
    stem = Path(filename).stem
    return FlashcardSource(
        format="anki_package",
        note_types={k: v for k, v in note_types.items() if k in used},
        notes=notes,
        decks=decks,
        title=_package_title(decks) or stem,
    )


def _package_title(decks: dict[str, int]) -> str | None:
    """Общий корень колод: «Английский::Глаголы» и «Английский::Фразы» → «Английский»."""
    names = [d for d in decks if d and d.casefold() not in ("default", "по умолчанию")]
    if not names:
        return None
    parts = [n.split("::") for n in names]
    common = []
    for level in zip(*parts):
        if len(set(level)) != 1:
            break
        common.append(level[0])
    return (common[-1] if common else None) or (parts[0][-1] if len(names) == 1 else None)


# --- Текстовые таблицы: экспорт Anki «Заметки в виде текста», Quizlet, CSV ---

SEPARATORS = {
    "tab": "\t",
    "comma": ",",
    "semicolon": ";",
    "pipe": "|",
    "space": " ",
    "colon": ":",
}
HEADER_NAMES = re.compile(
    r"^(front|back|question|answer|term|definition|word|translation|meaning|example|notes?|"
    r"extra|вопрос|ответ|термин|определение|слово|перевод|значение|пример|пояснение|"
    r"лицевая сторона|оборотная сторона|оборот|лицо)$",
    re.I,
)


def _decode(data: bytes) -> str:
    for encoding in ("utf-8-sig",):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            pass
    best = from_bytes(data).best()
    if best is None:
        raise invalid("Не удалось определить кодировку файла")
    return str(best)


def _sniff(lines: list[str]) -> str:
    """Разделитель — тот, что встречается одинаково часто в большинстве строк."""
    sample = [line for line in lines[:50] if line.strip()]
    best, score = "\t", 0.0
    for separator in ("\t", ";", ",", "|"):
        counts = [line.count(separator) for line in sample]
        if not counts or not any(counts):
            continue
        common = max(set(counts), key=counts.count)
        if common == 0:
            continue
        share = counts.count(common) / len(counts)
        # Табуляция почти не встречается в тексте: при равенстве выигрывает она.
        weight = share + (0.2 if separator == "\t" else 0)
        if weight > score:
            best, score = separator, weight
    return best


def read_table(data: bytes, filename: str) -> FlashcardSource:
    text = _decode(data)
    directives: dict[str, str] = {}
    body_lines = []
    for line in text.splitlines():
        match = re.match(r"^#([a-z ]+):(.*)$", line)
        if match and not body_lines:
            directives[match[1].strip().casefold()] = match[2].strip()
            continue
        body_lines.append(line)
    separator = directives.get("separator")
    separator = SEPARATORS.get(separator.casefold(), separator) if separator else None
    separator = separator or _sniff(body_lines)
    if len(separator) != 1 or separator in {"\n", "\r", "\0"}:
        raise invalid("Разделитель таблицы должен быть одним символом: например, tab или semicolon")
    is_html = directives.get("html", "").casefold() == "true" or (
        "html" not in directives and bool(re.search(r"<(br|div|b|i|span|img)\b", text, re.I))
    )
    rows = list(
        islice(
            (
                row
                for row in csv.reader(io.StringIO("\n".join(body_lines)), delimiter=separator)
                if any(cell.strip() for cell in row)
            ),
            MAX_NOTES + 2,
        )
    )
    if not rows:
        raise invalid("В файле нет строк с карточками")

    def column(name):
        value = directives.get(f"{name} column")
        return int(value) - 1 if value and value.isdigit() else None

    service = {
        c: k
        for k, c in (
            ("notetype", column("notetype")),
            ("deck", column("deck")),
            ("tags", column("tags")),
            ("guid", column("guid")),
        )
        if c is not None
    }
    names = directives.get("columns")
    header = names.split(separator) if names else None
    if header is None and all(HEADER_NAMES.match(cell.strip()) for cell in rows[0] if cell.strip()):
        header, rows = rows[0], rows[1:]
    if len(rows) > MAX_NOTES:
        raise DomainError(
            422, "flashcards_too_many", f"В файле больше {MAX_NOTES} строк: разделите его"
        )
    note_types: dict[str, NoteType] = {}
    notes = []
    decks: dict[str, int] = {}
    for index, row in enumerate(rows, 1):
        values = [cell for i, cell in enumerate(row) if i not in service]
        type_name = (
            row[service_index(service, "notetype")] if "notetype" in service.values() else ""
        )
        type_id = type_name or "table"
        note_type = note_types.get(type_id)
        if note_type is None:
            fields = [
                h.strip() for i, h in enumerate(header or []) if i not in service and h.strip()
            ]
            note_type = note_types[type_id] = NoteType(
                id=type_id, name=type_name or "Таблица", fields=fields
            )
        while len(note_type.fields) < len(values):
            note_type.fields.append(f"Столбец {len(note_type.fields) + 1}")
        deck = (
            row[service_index(service, "deck")].strip() if "deck" in service.values() else None
        ) or directives.get("deck")
        tags = row[service_index(service, "tags")].split() if "tags" in service.values() else []
        note_type.count += 1
        note_type.cloze = note_type.cloze or any(is_cloze(v) for v in values)
        if deck:
            decks[deck] = decks.get(deck, 0) + 1
        notes.append(
            Note(
                id=f"row-{index}",
                note_type=type_id,
                fields=values if is_html else [html.escape(v, quote=False) for v in values],
                deck=deck,
                tags=tags,
            )
        )
    return FlashcardSource(
        format="table",
        note_types=note_types,
        notes=notes,
        decks=decks,
        title=_package_title(decks) or Path(filename).stem,
    )


def service_index(service: dict[int, str], kind: str) -> int:
    return next(i for i, k in service.items() if k == kind)


def read_flashcards(data: bytes, filename: str) -> FlashcardSource:
    try:
        return _read_flashcards(data, filename)
    except (
        ValueError,
        TypeError,
        KeyError,
        IndexError,
        AttributeError,
        csv.Error,
        sqlite3.DatabaseError,
        zipfile.BadZipFile,
        RuntimeError,
        EOFError,
        zstandard.ZstdError,
    ) as exc:
        raise invalid(
            "Не удалось прочитать карточки. Файл повреждён или имеет незнакомую структуру."
        ) from exc


def _read_flashcards(data: bytes, filename: str) -> FlashcardSource:
    suffix = Path(filename).suffix.casefold()
    if suffix in (".apkg", ".colpkg") or data[:4] == b"PK\x03\x04":
        return read_package(data, filename)
    if suffix in (".txt", ".tsv", ".csv", ".text"):
        return read_table(data, filename)
    raise DomainError(
        415,
        "import_unsupported_type",
        "Подходят пакеты Anki (.apkg, .colpkg) и таблицы (.txt, .tsv, .csv)",
        {"filename": filename},
    )
