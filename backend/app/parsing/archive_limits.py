"""Проверка архивов до передачи распаковывающим библиотекам."""

from zipfile import ZipFile

from app.core.errors import DomainError

MIB = 1024 * 1024
MAX_DOCX_BYTES = 96 * MIB
MAX_DOCX_PART_BYTES = 32 * MIB
MAX_DOCX_PARTS = 4096


def check_docx_archive(source):
    # ZipFile смещает курсор BytesIO; Document должен прочитать тот же полный файл.
    position = source.tell() if hasattr(source, "tell") else None
    try:
        with ZipFile(source) as archive:
            entries = archive.infolist()
            if (
                len(entries) > MAX_DOCX_PARTS
                or sum(entry.file_size for entry in entries) > MAX_DOCX_BYTES
                or any(entry.file_size > MAX_DOCX_PART_BYTES for entry in entries)
            ):
                raise DomainError(
                    413,
                    "import_too_large",
                    "DOCX слишком велик после распаковки. Разделите документ.",
                )
    finally:
        if position is not None:
            source.seek(position)
