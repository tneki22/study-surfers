import io
import random
import zipfile

import pytest
import zstandard
from docx import Document
from docx.oxml import parse_xml
from test_flashcards import legacy_package, modern_package

from app.core.errors import DomainError
from app.flashcards import reader
from app.parsing import archive_limits, docx_content
from app.parsing.extract import extract_document


@pytest.mark.parametrize("modern", [False, True])
def test_anki_expansion_stops_before_large_output(monkeypatch, modern):
    data = modern_package([["Q", "A"]]) if modern else legacy_package([["Q", "A"]])
    monkeypatch.setattr(reader, "MAX_COLLECTION_BYTES", 100)
    with pytest.raises(DomainError) as exc:
        reader.read_flashcards(data, "test.apkg")
    assert exc.value.code == "import_too_large"


def test_nested_zstd_expansion_is_bounded(monkeypatch):
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("collection.anki21b", zstandard.ZstdCompressor().compress(b"x" * 10_000))
    monkeypatch.setattr(reader, "MAX_COLLECTION_BYTES", 1000)
    with pytest.raises(DomainError) as exc:
        reader.read_flashcards(output.getvalue(), "test.apkg")
    assert exc.value.code == "import_too_large"


def test_ordinary_zstd_megabyte_window_remains_supported(tmp_path):
    data = random.Random(42).randbytes(1024 * 1024)
    frame = zstandard.ZstdCompressor().compress(data)
    assert zstandard.get_frame_parameters(frame).window_size >= 1024 * 1024
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("collection.anki21b", frame)
    with zipfile.ZipFile(output) as archive:
        result = reader._collection(archive, tmp_path)
    assert result.read_bytes() == data


def test_note_limit_precedes_materialization(monkeypatch):
    data = legacy_package([["Q", "A"]] * 4)
    monkeypatch.setattr(reader, "MAX_NOTES", 2)
    with pytest.raises(DomainError) as exc:
        reader.read_flashcards(data, "test.apkg")
    assert exc.value.code == "flashcards_too_many"


@pytest.mark.parametrize(
    "text",
    [
        "#separator:broken\nq\ta",
        "#deck column:9\nq\ta",
        "#tags column:9\nq\ta",
        "#notetype column:9\nq\ta",
        "q\t" + "x" * 150_000,
    ],
    ids=["separator", "deck-column", "tags-column", "type-column", "long-field"],
)
def test_malformed_tables_have_domain_errors(client, text):
    response = client.post(
        "/api/imports/flashcards?dry_run=true", files={"file": ("bad.tsv", text.encode())}
    )
    assert response.status_code == 422
    assert response.json()["code"] == "flashcards_file_invalid"


def test_docx_secondary_part_limit_before_document_read(monkeypatch):
    document = Document()
    document.add_paragraph("Обычный текст")
    original = io.BytesIO()
    document.save(original)
    with zipfile.ZipFile(original, "a", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("word/media/large.bin", b"x" * 10_000)
    monkeypatch.setattr(archive_limits, "MAX_DOCX_PART_BYTES", 9000)
    with pytest.raises(DomainError) as exc:
        extract_document("test.docx", original.getvalue())
    assert exc.value.code == "import_too_large"


def test_corrupt_docx_xml_has_domain_error():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("[Content_Types].xml", "<broken")
    with pytest.raises(DomainError) as exc:
        extract_document("test.docx", output.getvalue())
    assert exc.value.code == "import_file_invalid"


@pytest.mark.parametrize("width", ["1000000000", "0", "-1"])
def test_docx_gridspan_rejected_before_allocation(width):
    node = parse_xml(
        f'<w:tbl xmlns:w="{docx_content.W[1:-1]}"><w:tr><w:tc><w:tcPr><w:gridSpan w:val="{width}"/></w:tcPr><w:p/></w:tc></w:tr></w:tbl>'
    )
    with pytest.raises(DomainError) as exc:
        docx_content.table_markdown(node)
    assert exc.value.code == "import_too_large"


def test_docx_padded_table_budget(monkeypatch):
    monkeypatch.setattr(docx_content, "MAX_TABLE_CELLS", 5)
    node = parse_xml(
        f'<w:tbl xmlns:w="{docx_content.W[1:-1]}"><w:tr><w:tc><w:tcPr><w:gridSpan w:val="4"/></w:tcPr><w:p><w:r><w:t>Wide</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p/></w:tc></w:tr></w:tbl>'
    )
    with pytest.raises(DomainError) as exc:
        docx_content.table_markdown(node)
    assert exc.value.code == "import_too_large"
