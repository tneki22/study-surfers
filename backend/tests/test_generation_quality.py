import json

import pytest
from test_jobs import PROMPTS, completion, configured, inject, start, wait_job, wire

from app.ai.client import AiClient
from app.ai.provider import FakeTransport, ProviderError
from app.core.errors import DomainError
from app.core.text import visible_len
from app.models import Question
from app.pipeline.generate import generate_question
from app.pipeline.jobs import _merge_warnings
from app.pipeline.validate import same_front, same_option, validate_item

__all__ = ["configured"]


def item_from_wire(candidate):
    return {
        **{k: v for k, v in candidate.items() if not k.startswith("distractors_")},
        "distractors": [
            {**d, "kind": kind}
            for kind, pool in (
                ("far", candidate["distractors_far"]),
                ("near", candidate["distractors_near"]),
            )
            for d in pool
        ],
    }


def numeric_wire(correct="1", options=("10", "11", "12", "20", "21", "22")):
    return wire(
        correct=correct,
        distractors_far=[{"text": t, "why_wrong": "Другое значение"} for t in options[:3]],
        distractors_near=[{"text": t, "why_wrong": "Другое значение"} for t in options[3:]],
    )


def question(target=3, reference=None):
    return Question(
        id="quality-question",
        text="Работа и единицы измерения",
        section=None,
        items_target=target,
        answer_text=reference,
    )


def repair_context(fake):
    content = fake.complete_requests[1]["messages"][-1]["content"]
    return json.loads(content.split("<repair_context>", 1)[1].split("</repair_context>", 1)[0])


@pytest.mark.parametrize(
    "correct,options",
    [
        ("1", ("10", "11", "12", "20", "21", "22")),
        ("100", ("1", "2", "3", "4", "5", "6")),
        ("-1", ("-100", "100", "0", "2", "10", "20")),
        ("49 лет", ("1 год", "5 лет", "100 лет", "200 лет", "40 лет", "60 лет")),
        ("$R = r$", ("$R = 2r$", "$R = 3r$", "$R = 4r$", "$R = 5r$", "$R = 6r$", "$R = 7r$")),
        ("$N=K/2$", ("$N=K/3$", "$N=K/4$", "$N=K/5$", "$N=K/6$", "$N=K/7$", "$N=K/8$")),
        ("1917", ("17", "1812", "1905", "1922", "1941", "1945")),
    ],
)
def test_short_answers_pass_both_length_checks(correct, options):
    item = item_from_wire(numeric_wire(correct, options))
    cleaned, issues = validate_item(item, prune=True)
    assert issues == []
    assert len(cleaned["distractors"]) == 6


@pytest.mark.parametrize("correct,option", [("1", "10000"), ("49 лет", "От 18 до 25 лет")])
def test_short_answer_tolerance_still_rejects_long_phrases(correct, option):
    item = item_from_wire(numeric_wire(correct))
    item["distractors"] = [{"text": option, "kind": "near", "why_wrong": "Ошибка"}]
    dropped = []
    cleaned, issues = validate_item(item, prune=True, dropped=dropped)
    assert cleaned["distractors"] == [] and issues
    assert any("Слишком длинный" in r for r in dropped[0]["reasons"])


def test_long_correct_answer_cannot_stand_out():
    item = item_from_wire(wire(correct="Необычайно длинный полный ответ на экзаменационный вопрос"))
    assert validate_item(item, prune=True)[1]
    item = item_from_wire(wire())
    item["correct"] = "Полный ответ"
    for d, text in zip(
        item["distractors"], ("Импульс", "Система", "Действие", "Падение", "Частота", "Скорость")
    ):
        d["text"] = text
    cleaned, issues = validate_item(item, prune=True)
    assert len(cleaned["distractors"]) == 6
    assert "Верный ответ выделяется длиной" in issues


@pytest.mark.parametrize(
    "correct,prompt,options",
    [
        (
            "-10 см",
            "Где находится изображение при f = 10 см и d = 5 см у тонкой собирающей линзы?",
            ("-20 см", "5 см", "10 см", "-5 см", "0 см", "20 см"),
        ),
        (
            "20 см",
            "Где находится изображение предмета в 20 см от собирающей линзы с f = 10 см?",
            ("-20 см", "40 см", "60 см", "0 см", "10 см", "-10 см"),
        ),
    ],
)
def test_numeric_answer_matching_input_is_not_an_answer_leak(correct, prompt, options):
    item = item_from_wire(numeric_wire(correct, options))
    item["prompt"] = prompt
    assert validate_item(item, prune=True)[1] == []


def test_textual_answer_leak_is_still_rejected():
    item = item_from_wire(wire("Какая физическая величина — энергия?"))
    assert "Вопрос содержит верный ответ" in validate_item(item, prune=True)[1]


@pytest.mark.parametrize(
    "left,right",
    [
        ("Концентрация 10 мг/л", "Концентрация 20 мг/л"),
        ("Температура -10 градусов", "Температура 10 градусов"),
        ("Доля 0,5 процента", "Доля 0,6 процента"),
        ("Дата события 01.01.1900", "Дата события 01.01.1901"),
        ("Формула R = r", "Формула R = -r"),
        ("Формула N = K/2", "Формула N = K/3"),
        ("a+b+c+d+e+f", "a-b+c+d+e+f"),
        ("$ax+by+cz+dw+ev$", "$ax-by+cz+dw+ev$"),
        ("-1", "1"),
        (
            "Неделя до и неделя после осеннего Юрьева дня",
            "Неделя до и неделя после весеннего Юрьева дня",
        ),
        (
            "Ортонормированный базис для симметричных матриц",
            "Ортонормированный базис для любых матриц",
        ),
        ("Повторить всю транзакцию целиком", "Не повторить всю транзакцию целиком"),
    ],
)
def test_numbers_and_formula_changes_are_not_duplicates(left, right):
    assert not same_option(left, right)


@pytest.mark.parametrize(
    "left,right",
    [
        ("Правильный ответ", "Правильный ответ!"),
        ("Концентрация 10 мг/л", "Концентрация 10 мг/л."),
        ("Кто-то", "Кто то"),
        ("Температура −10 градусов", "Температура - 10 градусов"),
        ("Формула R = r", "Формула R=r!"),
        ("$R = 2r$", "$R=2r$"),
        ("Измерение температуры тела", "Измерение температурры тела"),
    ],
)
def test_real_duplicates_are_still_rejected(left, right):
    assert same_option(left, right)


@pytest.mark.parametrize(
    "left,right",
    [
        (
            "Какое изображение даёт тонкая собирающая линза с фокусным расстоянием 10 см, "
            "если предмет находится на расстоянии 15 см от линзы?",
            "Какое изображение даёт тонкая собирающая линза с фокусным расстоянием 10 см, "
            "если предмет находится на расстоянии 5 см от линзы?",
        ),
        ("Как меняется рост при $N>K$?", "Как меняется рост при $N<K$?"),
        (
            "Как меняется равновесие при постоянном объёме?",
            "Как меняется равновесие при постоянном давлении?",
        ),
    ],
)
def test_different_question_conditions_are_not_duplicates(left, right):
    assert not same_front(left, right)


def test_same_question_with_punctuation_or_typo_is_duplicate():
    assert same_front("Что такое геометрическая кратность?", "Что такое геометрическая кратность!")
    assert same_front("Что такое геометрическая кратность?", "Что такое геометрическкая кратность?")


@pytest.mark.parametrize(
    "option,reason",
    [
        ({"text": "", "kind": "near", "why_wrong": ""}, "1–70 видимых"),
        ({"text": "А", "kind": "near", "why_wrong": ""}, "Слишком короткий"),
        ({"text": "Слишком длинный вариант", "kind": "near", "why_wrong": ""}, "Слишком длинный"),
        ({"text": "Энергия", "kind": "near", "why_wrong": ""}, "Дубликат"),
        ({"text": "$x+1", "kind": "near", "why_wrong": ""}, "непарные"),
        ({"text": "Мощность", "kind": "other", "why_wrong": ""}, "Неизвестный тип"),
        ({"text": "Мощность", "kind": "near", "why_wrong": "А" * 121}, "why_wrong"),
        ({"text": "Оба варианта", "kind": "near", "why_wrong": ""}, "Запрещённый"),
        ({"text": "А" * 121, "kind": "near", "why_wrong": ""}, "Сырая длина 121"),
    ],
)
def test_pruning_explains_each_reason_without_invalidating_usable_card(option, reason):
    item = item_from_wire(wire())
    item["distractors"].append(option)
    dropped = []
    cleaned, issues = validate_item(item, prune=True, dropped=dropped)
    assert issues == [] and len(cleaned["distractors"]) == 6
    assert len(item["distractors"]) == 7  # Исходный объект не изменён.
    assert len(dropped) == 1 and dropped[0]["kind"] == option["kind"]
    assert any(reason in r for r in dropped[0]["reasons"])
    strict_issues = validate_item(item)[1]
    assert any(reason in issue for issue in strict_issues)


def test_pruning_reports_duplicates_between_distractors_and_pool_overflow():
    item = item_from_wire(wire())
    item["distractors"].extend(
        [
            {"text": "Мощность!", "kind": "near", "why_wrong": "Повтор"},
            {"text": "Ускорение", "kind": "far", "why_wrong": "Другая величина"},
        ]
    )
    dropped = []
    assert validate_item(item, prune=True, dropped=dropped)[1] == []
    assert "Дубликат варианта «Мощность»" in dropped[0]["reasons"]
    assert "Слишком много вариантов в пуле" in dropped[1]["reasons"]


async def test_repair_has_every_failed_card_and_preserves_valid_results(configured):
    invalid = [
        wire(p, correct="Необычайно длинный полный ответ на экзаменационный вопрос")
        for p in PROMPTS[1:]
    ]
    initial = [wire(PROMPTS[0]), *invalid]
    assert len(json.dumps(initial, ensure_ascii=False)) > 1500
    fake = FakeTransport(
        completions=[completion(initial), completion([wire(p) for p in PROMPTS[1:]])]
    )
    batch = await generate_question(AiClient(fake), question())
    assert [i["prompt"] for i in batch.items] == PROMPTS
    assert batch.warnings == [] and batch.error is None
    context = repair_context(fake)
    assert context["target"] == 2 and context["avoid"] == [PROMPTS[0]]
    assert [i["ordinal"] for i in context["items"]] == [2, 3]
    assert [i["prompt"] for i in context["items"]] == PROMPTS[1:]
    assert all(i["correct"] == invalid[0]["correct"] for i in context["items"])
    assert all(len(i["dropped_distractors"]) == 6 for i in context["items"])
    assert all(
        any("Слишком короткий" in r for r in d["reasons"])
        for i in context["items"]
        for d in i["dropped_distractors"]
    )
    assert len(json.dumps(context, ensure_ascii=False)) > 800
    assert len(fake.complete_requests) == 2


async def test_repair_can_fix_unbalanced_formulas_and_duplicates(configured):
    initial = wire()
    initial["distractors_near"] = [
        {"text": "Энергия", "why_wrong": "Повтор верного ответа"},
        {"text": "$x+1", "why_wrong": "Сломанная формула"},
        {"text": "Импульс", "why_wrong": "Другая величина"},
    ]
    fake = FakeTransport(completions=[completion([initial]), completion([wire()])])
    batch = await generate_question(AiClient(fake), question(1))
    assert len(batch.items) == 1 and batch.warnings == []
    dropped = repair_context(fake)["items"][0]["dropped_distractors"]
    assert any("Дубликат" in r for r in dropped[0]["reasons"])
    assert any("непарные" in r for r in dropped[1]["reasons"])


async def test_refill_is_requested_even_when_first_batch_has_no_validation_errors(configured):
    fake = FakeTransport(
        completions=[completion([wire()]), completion([wire(p) for p in PROMPTS[1:]])]
    )
    batch = await generate_question(AiClient(fake), question())
    assert len(batch.items) == 3 and batch.warnings == []
    assert repair_context(fake)["items"] == []
    assert repair_context(fake)["target"] == 2


async def test_similar_questions_with_different_numbers_all_survive(configured):
    prompts = [
        f"Какое изображение даёт тонкая собирающая линза с фокусным расстоянием 10 см, "
        f"если предмет находится на расстоянии {distance} см от линзы?"
        for distance in (5, 15, 20)
    ]
    fake = FakeTransport(completions=[completion([wire(p) for p in prompts])])
    batch = await generate_question(AiClient(fake), question())
    assert [i["prompt"] for i in batch.items] == prompts
    assert len(fake.complete_requests) == 1 and batch.warnings == []


async def test_large_avoid_list_is_compact_but_all_duplicates_are_checked(configured):
    avoid = [f"Старый вопрос из колоды номер {index}" for index in range(100)]
    fake = FakeTransport(
        completions=[
            completion([wire()]),
            completion([wire(avoid[0]), *[wire(p) for p in PROMPTS[1:]]]),
        ]
    )
    batch = await generate_question(AiClient(fake), question(), avoid=avoid)
    assert [i["prompt"] for i in batch.items] == PROMPTS
    assert repair_context(fake)["avoid"] == [*avoid[-3:], PROMPTS[0]]


async def test_repeated_refill_is_bounded_and_reports_shortfall(configured):
    fake = FakeTransport(completions=[completion([wire()]), completion([wire()])])
    batch = await generate_question(AiClient(fake), question())
    assert len(fake.complete_requests) == 2 and len(batch.items) == 1
    assert batch.error is None
    assert batch.warnings == [
        {
            "code": "generation_shortfall",
            "message": "Для вопроса «Работа и единицы измерения» создано 1 из 3 карточек",
            "context": {
                "question_id": "quality-question",
                "requested": 3,
                "created": 1,
                "missing": 2,
            },
        }
    ]


async def test_repair_can_be_disabled_and_shortfall_remains_visible(configured):
    fake = FakeTransport(completions=[completion([wire()])])
    batch = await generate_question(AiClient(fake), question(), allow_repair=False)
    assert len(fake.complete_requests) == 1 and len(batch.items) == 1
    assert batch.warnings[0]["context"]["missing"] == 2


async def test_only_one_additional_request_for_multiple_reference_chunks(configured):
    prompts = [*PROMPTS, "Какую величину передают телу при нагревании?"]
    fake = FakeTransport(completions=[completion([wire(p)]) for p in prompts])
    batch = await generate_question(AiClient(fake), question(6, "А" * 6000))
    assert len(fake.complete_requests) == 4  # Три части исходника + один ремонт.
    assert len(batch.items) == 4
    assert batch.warnings[0]["context"]["missing"] == 2


async def test_invalid_duplicate_does_not_block_later_valid_card(configured):
    invalid = wire(correct="Необычайно длинный полный ответ на экзаменационный вопрос")
    fake = FakeTransport(completions=[completion([invalid, *[wire(p) for p in PROMPTS]])])
    batch = await generate_question(AiClient(fake), question())
    assert [i["prompt"] for i in batch.items] == PROMPTS
    assert len(fake.complete_requests) == 1 and batch.warnings == []


async def test_bad_surplus_option_does_not_trigger_repair(configured):
    candidate = wire()
    candidate["distractors_near"].append({"text": "Энергия", "why_wrong": "Дубликат"})
    fake = FakeTransport(completions=[completion([candidate])])
    batch = await generate_question(AiClient(fake), question(1))
    assert len(batch.items) == 1 and len(fake.complete_requests) == 1


async def test_short_numeric_card_survives_generation_without_repair(configured):
    fake = FakeTransport(completions=[completion([numeric_wire()])])
    batch = await generate_question(AiClient(fake), question(1))
    assert len(batch.items) == 1 and len(fake.complete_requests) == 1
    assert visible_len(batch.items[0]["correct"]) == 1 and batch.warnings == []


@pytest.mark.parametrize("target,budget", [(1, 8000), (3, 12000), (5, 20000)])
async def test_output_budget_scales_with_requested_batch(configured, target, budget):
    fake = FakeTransport(completions=[completion([wire(p) for p in PROMPTS]), completion([])])
    await generate_question(AiClient(fake), question(target))
    assert fake.complete_requests[0]["max_output_tokens"] == budget


async def test_failed_repair_keeps_valid_cards(configured):
    fake = FakeTransport(
        completions=[completion([wire()]), ProviderError("ai_request_rejected", "Отказ сервиса")]
    )
    batch = await generate_question(AiClient(fake), question())
    assert len(batch.items) == 1 and batch.error is None
    assert [w["code"] for w in batch.warnings] == [
        "generation_retry_failed",
        "generation_shortfall",
    ]


async def test_repair_does_not_hide_invalid_credentials(configured):
    fake = FakeTransport(
        completions=[completion([wire()]), ProviderError("ai_invalid_credentials", "Неверный ключ")]
    )
    with pytest.raises(DomainError) as error:
        await generate_question(AiClient(fake), question())
    assert error.value.code == "ai_invalid_credentials"


async def test_quote_fallback_survives_empty_repair(configured):
    invalid_quote = wire(source="user_docs", evidence_quote="Выдуманная цитата без основания")
    fake = FakeTransport(completions=[completion([invalid_quote]), completion([])])
    batch = await generate_question(AiClient(fake), question(1, "Энергия измеряется в джоулях."))
    assert len(batch.items) == 1 and batch.items[0]["source"] == "ai_knowledge"
    assert batch.warnings[0]["code"] == "quote_downgraded"


async def test_confirmed_quote_repair_replaces_fallback(configured):
    reference = "Энергия в международной системе единиц измеряется в джоулях."
    invalid = wire(source="user_docs", evidence_quote="Выдуманная цитата без основания")
    repaired = wire(source="user_docs", evidence_quote=reference)
    fake = FakeTransport(completions=[completion([invalid]), completion([repaired])])
    batch = await generate_question(AiClient(fake), question(1, reference))
    assert len(batch.items) == 1 and batch.items[0]["source"] == "user_docs"
    assert batch.warnings == []


async def test_zero_valid_cards_have_error_and_shortfall(configured):
    invalid = wire(correct="Необычайно длинный полный ответ на экзаменационный вопрос")
    fake = FakeTransport(completions=[completion([invalid]), completion([invalid])])
    batch = await generate_question(AiClient(fake), question())
    assert batch.items == [] and "Слишком короткий" in batch.error
    assert batch.warnings[0]["context"]["created"] == 0


def test_shortfall_reaches_job_api(configured, client, monkeypatch):
    class RepeatingTransport(FakeTransport):
        async def complete(self, **kwargs):
            content = kwargs["messages"][1]["content"]
            context = json.loads(content.removeprefix("<context>").removesuffix("</context>"))
            prompts = dict(
                zip(
                    [
                        "Работа и единицы измерения",
                        "Законы сохранения системы",
                        "Тепловые процессы и работа",
                    ],
                    PROMPTS,
                )
            )
            self.completions.append(completion([wire(prompts[context["question"]])]))
            return await super().complete(**kwargs)

    fake = RepeatingTransport()
    inject(monkeypatch, fake)
    imported = start(client, items_per_question=3)
    job = wait_job(client, imported["job_id"])
    assert job["state"] == "done" and job["ready_items"] == 3
    shortfalls = [w for w in job["warnings"] if w["code"] == "generation_shortfall"]
    assert len(shortfalls) == 3
    assert all("1 из 3" in w["message"] and w["context"]["missing"] == 2 for w in shortfalls)
    assert len({w["context"]["question_id"] for w in shortfalls}) == 3
    assert len(fake.complete_requests) == 6


def test_shortfall_warnings_for_different_questions_are_not_merged():
    warnings = [
        {
            "code": "generation_shortfall",
            "message": message,
            "context": {"question_id": str(index), "requested": 3, "created": index},
        }
        for index, message in enumerate(["Создано 0 из 3", "Создано 1 из 3"])
    ]
    assert _merge_warnings(warnings[:1], warnings[1:]) == warnings


def sent_context(fake):
    content = fake.complete_requests[0]["messages"][1]["content"]
    return json.loads(content.removeprefix("<context>").removesuffix("</context>"))


async def test_notes_topic_sends_program_context(configured):
    topic = question(1, "Энергия — способность тела совершать работу. " * 3)
    topic.synthetic = True
    topic.key_points = ["Определение энергии", "x" * 300]
    fake = FakeTransport(completions=[completion([wire()])])
    await generate_question(
        AiClient(fake), topic, neighbors={"previous": "Работа силы", "next": None}
    )
    context = sent_context(fake)
    assert context["material"] == "notes"
    assert context["key_points"] == ["Определение энергии", "x" * 160]
    assert context["neighbors"] == {"previous": "Работа силы"}
    assert "key_points" in fake.complete_requests[0]["messages"][0]["content"]


async def test_exam_answer_without_program_keeps_context_compact(configured):
    fake = FakeTransport(completions=[completion([wire()])])
    await generate_question(AiClient(fake), question(1, "Энергия — мера работы. " * 3))
    assert not {"material", "key_points", "neighbors"} & set(sent_context(fake))
