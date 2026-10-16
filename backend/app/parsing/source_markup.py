"""Исходники Typst и LaTeX: текст для структуры, формулы для модели.

Не компилируем документы: исходные формулы сохраняются, внешние файлы не читаются.
Typst помечается явно, чтобы модель не приняла его математический синтаксис за LaTeX.
"""

import re

from app.parsing.quality import reading_warning

SUPPORTED_KINDS = frozenset({"txt", "md", "pdf", "docx", "typ", "tex"})
SUPPORTED_LABEL = "PDF, DOCX, TXT, MD, Typst (.typ) и LaTeX (.tex)"


def normalize_source(text: str, kind: str) -> tuple[str, bool]:
    if kind == "typ":
        # Комментарии только вне строк; URL и строки сохраняются.
        text = re.sub(
            r'"(?:\\.|[^"\\])*"|(?<!:)//[^\n]*|/\*.*?\*/',
            lambda m: m[0] if m[0].startswith('"') else "\n" * m[0].count("\n"),
            text,
            flags=re.S,
        )
        dependencies = bool(re.search(r"#(?:include|import|let|show|for|if)\b", text))
        text = re.sub(r"^(={1,6})\s+", lambda m: "#" * len(m[1]) + " ", text, flags=re.M)
        # Исходник формулы сохраняем дословно, включая пробелы выносной формулы.
        text = re.sub(
            r'"(?:\\.|[^"\\])*"|`[^`]*`|(?<!\\)\$([^$]+?)(?<!\\)\$',
            lambda m: f"\n```typst\n{m[0]}\n```\n" if m[0].startswith("$") else m[0],
            text,
            flags=re.S,
        )
    else:
        text = re.sub(r"(?<!\\)%[^\n]*", "", text)
        dependencies = bool(
            re.search(r"\\(?:input|include|newcommand|renewcommand|def|includegraphics)\b", text)
        )
        # Шапка нужна для пользовательских макросов; учебный текст не теряется.
        text = re.sub(r"\\(?:sub)*section\*?\{([^{}]*)\}", r"\n## \1\n", text)
        text = re.sub(r"\\(?:chapter|part)\*?\{([^{}]*)\}", r"\n# \1\n", text)
        text = re.sub(r"\\begin\{document\}|\\end\{document\}", "", text)
        text = re.sub(r"\\(?:textbf|emph|textit)\{([^{}]*)\}", r"\1", text)
        text = re.sub(r"\\item\b\s*", "\n- ", text)
    return text.strip(), dependencies


def source_warnings(filename: str, dependencies: bool) -> list[dict]:
    if not dependencies:
        return []
    return [
        reading_warning(
            "source_requires_review",
            "В документе есть команды, макросы или ссылки на другие файлы. "
            "Читается только загруженный исходник, поэтому часть текста или формул может "
            "не попасть в карточки. Проверьте полноту материала.",
            filename,
        )
    ]
