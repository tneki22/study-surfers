import re
from difflib import SequenceMatcher
from statistics import median

from app.core.text import norm_option, norm_quote, visible_len

FORBIDDEN = re.compile(r"все перечисленн|нет верного|оба вариант", re.I)
# Карточка играется без исходника: ссылка на «источник» или «лекцию» делает вопрос непонятным.
SOURCE_REFERENCE = re.compile(
    r"\b(в|из|по)\s+(источник\w*|тексте|лекци\w*|материал\w*|конспект\w*|документ\w*)"
    r"|\bприводится\b",
    re.I,
)
SHORT_ANSWER_MAX = 10
SHORT_ANSWER_TOLERANCE = 3
PLAIN_FORMULA = re.compile(r"\b[A-Za-zΑ-ω]\w*(?:\s*[-+*/^=<>≤≥≠≈]\s*[+\-]?\w+)+")


def option_length_bounds(correct_length: int) -> tuple[float, float]:
    lower, upper = 0.5 * correct_length, 2 * correct_length
    if correct_length <= SHORT_ANSWER_MAX:
        lower = min(lower, correct_length - SHORT_ANSWER_TOLERANCE)
        upper = max(upper, correct_length + SHORT_ANSWER_TOLERANCE)
    return max(1, lower), min(70, upper)


def balanced_formula(text: str) -> bool:
    if len(re.findall(r"(?<!\\)\$", text)) % 2:
        return False
    stack = []
    pairs = {"}": "{", ")": "(", "]": "["}
    for char in re.sub(r"\\[{}]", "", text):
        if char in "{([":
            stack.append(char)
        elif char in pairs:
            if not stack or stack.pop() != pairs[char]:
                return False
    return not stack


def valid_quote(quote: str | None, reference: str | None) -> bool:
    value = norm_quote(quote or "")
    return bool(
        len(value) >= 15
        and "…" not in value
        and "..." not in value
        and value in norm_quote(reference or "")
    )


def same_front(left: str, right: str) -> bool:
    # Разные числа, формулы и условия задают разные задачи даже при общем шаблоне.
    return same_option(left, right)


def same_option(left: str, right: str) -> bool:
    a, b = norm_option(left), norm_option(right)
    math_a = [norm_option(v) for v in re.findall(r"\$[^$]+\$", left)]
    math_b = [norm_option(v) for v in re.findall(r"\$[^$]+\$", right)]

    def significant_parts(text):
        text = norm_quote(text)
        text = re.sub(r"([+\-])\s+(?=\d)", r"\1", text)
        numbers = re.findall(r"[+\-]?\d+(?:[.,]\d+)?", text)
        formulas = [
            re.sub(r"\s+", "", match)
            for match in PLAIN_FORMULA.findall(text)
            if re.search(r"[+*/^=<>≤≥≠≈]", match)
        ]
        return numbers, formulas

    # Числа с единицами и формулы без $…$ тоже могут отличаться одним знаком.
    if math_a != math_b or significant_parts(left) != significant_parts(right):
        return False
    if a == b:
        return True
    numeric = all(re.fullmatch(r"[\s+\-−\d.,/%]+", v) for v in (left, right))
    if numeric:
        return False
    words_a = re.findall(r"[^\W\d_]+", norm_quote(left))
    words_b = re.findall(r"[^\W\d_]+", norm_quote(right))
    # Высокая похожесть целой фразы не делает «весенний» и «осенний» синонимами.
    # Допускаем опечатки внутри длинных слов, но сохраняем замену условия и отрицание.
    if len(words_a) != len(words_b) or any(
        SequenceMatcher(None, x, y).ratio() < 0.9 for x, y in zip(words_a, words_b)
    ):
        return False
    return SequenceMatcher(None, a, b).ratio() >= 0.92


def validate_item(
    item: dict,
    reference: str | None = None,
    *,
    check_quote: bool = False,
    prune: bool = False,
    dropped: list[dict] | None = None,
) -> tuple[dict, list[str]]:
    item = dict(item)
    issues: list[str] = []
    prompt, correct = item.get("prompt", ""), item.get("correct", "")
    if not 8 <= visible_len(prompt) <= 160 or len(prompt) > 240:
        issues.append("Вопрос должен содержать 8–160 видимых знаков (до 240 сырых)")
    if not 1 <= visible_len(correct) <= 70 or len(correct) > 120:
        issues.append("Верный ответ должен содержать 1–70 видимых знаков (до 120 сырых)")
    if visible_len(item.get("explanation", "")) > 300:
        issues.append("Объяснение длиннее 300 знаков")
    if any(not balanced_formula(v) for v in (prompt, correct, item.get("explanation", ""))):
        issues.append("Формула содержит непарные символы или скобки")
    if SOURCE_REFERENCE.search(prompt):
        issues.append("Вопрос ссылается на источник: карточка должна быть понятна без него")
    if FORBIDDEN.search(correct):
        issues.append("Верный ответ содержит запрещённый вариант")
    normalized = norm_option(correct)
    quantitative = (
        bool(re.match(r"^[+\-−]?\d", correct.strip()))
        or "$" in correct
        or bool(PLAIN_FORMULA.fullmatch(correct.strip()))
    )
    # В расчёте ответ может совпасть с входным числом: d=2f даёт b=d.
    # Также нормализация фразы «-10 см» убирает минус и даёт ложное совпадение с «10 см».
    # Наличие числовой величины в условии само по себе не является подсказкой ответа.
    if not quantitative and len(normalized) >= 4 and normalized in norm_option(prompt):
        issues.append("Вопрос содержит верный ответ")
    kept: list[dict] = []
    seen = [correct]
    correct_length = visible_len(correct)
    lower, upper = option_length_bounds(correct_length)
    for option in item.get("distractors", []):
        option = dict(option)
        text = option.get("text", "")
        length = visible_len(text)
        reasons = []
        if not 1 <= length <= 70:
            reasons.append(f"Длина варианта {length}: нужно 1–70 видимых знаков")
        if len(text) > 120:
            reasons.append(f"Сырая длина {len(text)}: максимум 120 знаков")
        if visible_len(option.get("why_wrong", "")) > 120:
            reasons.append("why_wrong длиннее 120 видимых знаков")
        if option.get("kind") not in ("near", "far"):
            reasons.append("Неизвестный тип: нужен near или far")
        if FORBIDDEN.search(text):
            reasons.append("Запрещённый вариант ответа")
        if not balanced_formula(text):
            reasons.append("Формула содержит непарные символы или скобки")
        duplicate = next((previous for previous in seen if same_option(text, previous)), None)
        if duplicate is not None:
            reasons.append(f"Дубликат варианта «{duplicate[:120]}»")
        if not lower <= length <= upper:
            direction = "короткий" if length < lower else "длинный"
            reasons.append(
                f"Слишком {direction}: {length} видимых знаков; "
                f"при длине correct {correct_length} нужно {lower:g}–{upper:g}"
            )
        if not reasons and sum(d["kind"] == option["kind"] for d in kept) >= (
            3 if option["kind"] == "far" else 4
        ):
            reasons.append("Слишком много вариантов в пуле")
        if reasons:
            if dropped is not None:
                dropped.append({"text": text[:120], "kind": option.get("kind"), "reasons": reasons})
            if not prune:
                issues.append(f"Неверный вариант «{text}»: {'; '.join(reasons)}")
            continue
        kept.append(option)
        seen.append(text)
    for kind, minimum in (("far", 2), ("near", 3)):
        if sum(d["kind"] == kind for d in kept) < minimum:
            issues.append(f"Недостаточно вариантов {kind}: нужно {minimum}")
    if kept:
        lengths = [visible_len(d["text"]) for d in kept]
        middle, longest = median(lengths), max(lengths)
        tolerance = SHORT_ANSWER_TOLERANCE if correct_length <= SHORT_ANSWER_MAX else 0
        median_imbalance = not 0.6 <= correct_length / max(1, middle) <= 1.6
        if (median_imbalance and abs(correct_length - middle) > tolerance) or (
            correct_length > longest * 1.25 and correct_length - longest > tolerance
        ):
            issues.append("Верный ответ выделяется длиной")
    if (
        check_quote
        and item.get("source") == "user_docs"
        and not valid_quote(item.get("evidence_quote"), reference)
    ):
        issues.append("Цитата не найдена в эталонном ответе")
    item["distractors"] = kept if prune else item.get("distractors", [])
    return item, issues
