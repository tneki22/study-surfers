"""Признаки потери текста и формул; это предупреждения, а не проверка смысла."""

import re
import unicodedata

RECOVERY_STEPS = [
    "Сначала распознайте текст в файле через OCR (распознавание текста), "
    "сохраните результат и загрузите его снова.",
    "Либо попросите другую модель проанализировать исходный файл и выдать весь материал "
    "в текстовом формате: без пропусков, с читаемыми формулами. "
    "Затем загрузите этот текст или вставьте его сюда.",
]
FORMULA_HELP = (
    "Если в файле есть формулы, проверьте знаки, дроби, степени и индексы после распознавания. "
    "Попросите сохранить их в LaTeX ($…$), чтобы они отображались на карточках. "
    "Можно загрузить исходный документ .tex или .typ."
)
MOJIBAKE_RE = re.compile(r"(?:[РС][^\s]){4,}|(?:[ÃÂ][^\s]){3,}")
MATH_RE = re.compile(r"[∑∏∫√∞≤≥≠≈∂∀∃]|\\(?:frac|sqrt|sum|int)\b")
MATH_SPAN_RE = re.compile(r"(?<!\\)(\$\$?)(.+?)(?<!\\)\1", re.S)
MATH_ENV_RE = re.compile(
    r"\\(begin|end)\{((?:equation|align|gather|multline|displaymath|math)\*?)\}"
)


def reading_warning(code: str, message: str, filename: str, **context) -> dict:
    return {
        "code": code,
        "message": message,
        "context": {
            "filename": filename,
            "recovery_steps": RECOVERY_STEPS,
            "formula_help": FORMULA_HELP,
            **context,
        },
    }


def unreadable_text(text: str) -> bool:
    visible = [c for c in text if not c.isspace()]
    if not visible:
        return False
    broken = sum(c == "\ufffd" or unicodedata.category(c) in {"Co", "Cs", "Cc"} for c in visible)
    return broken >= max(2, len(visible) * 0.01) or bool(MOJIBAKE_RE.search(text))


def broken_math(text: str, kind: str) -> bool:
    # Примеры кода и денежные суммы не считаются формулами.
    text = re.sub(r"```.*?```|`[^`\n]*`", "", text, flags=re.S)
    dollars = re.findall(r"(?<!\\)\$\$?", text)
    if dollars and (kind in {"typ", "tex"} or re.search(r"\$[^\n]*[=^_+\\]", text)):
        stack = []
        for delimiter in dollars:
            if stack and stack[-1] == delimiter:
                stack.pop()
            else:
                stack.append(delimiter)
        if stack:
            return True
    for opening, closing in ((r"\(", r"\)"), (r"\[", r"\]")):
        if text.count(opening) != text.count(closing):
            return True
    environments = []
    for match in MATH_ENV_RE.finditer(text):
        if match[1] == "begin":
            environments.append(match[2])
        elif not environments or environments.pop() != match[2]:
            return True
    if environments:
        return True
    spans = [m[2] for m in MATH_SPAN_RE.finditer(text)]
    spans += re.findall(r"\\\[(.*?)\\\]|\\\((.*?)\\\)", text, flags=re.S)
    for span in spans:
        value = "".join(span) if isinstance(span, tuple) else span
        if any(c == "\ufffd" or unicodedata.category(c) in {"Co", "Cs", "Cc"} for c in value):
            return True
        # Интервалы [a,b) законны; проверяем только структурные фигурные скобки.
        depth = 0
        for char in re.sub(r"\\[{}]", "", value):
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
            if depth < 0:
                return True
        if depth:
            return True
    return False


def text_warnings(filename: str, kind: str, text: str) -> list[dict]:
    warnings = []
    if not text.strip() and kind != "pdf":
        warnings.append(
            reading_warning(
                "document_no_text",
                "Не удалось прочитать текст: файл пуст или материал сохранён картинками.",
                filename,
            )
        )
    if unreadable_text(text):
        warnings.append(
            reading_warning(
                "document_text_unreadable",
                "Текст прочитан с ошибками: найдены испорченные или непонятные символы. "
                "Из-за этого карточки могут содержать ошибки.",
                filename,
            )
        )
    if broken_math(text, kind):
        warnings.append(
            reading_warning(
                "formulas_invalid",
                "В некоторых формулах найдены ошибки: испорченные символы, незакрытые "
                "границы формулы или скобки. Они могут неправильно отображаться на карточках.",
                filename,
            )
        )
    return warnings
