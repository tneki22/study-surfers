"""Реальные прогоны generate_question; запуск требует явного --live.

Не создаёт колоды и не меняет выбор модели. Расход записывается штатным AiClient.
Результаты и ответы сохраняются под data/qa/ и не коммитятся.
"""

import argparse
import asyncio
import hashlib
import json
import sys
from dataclasses import asdict
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from time import monotonic
from types import SimpleNamespace
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from generation_eval_cases import CUSTOM_PROMPT, SUBJECTS  # noqa: E402
from sqlalchemy import func, select  # noqa: E402

from app.ai.catalog import production_transport  # noqa: E402
from app.ai.client import AiClient, clean_json  # noqa: E402
from app.ai.models import AiCall  # noqa: E402
from app.ai.provider import ProviderError  # noqa: E402
from app.core.errors import DomainError  # noqa: E402
from app.db import session_factory  # noqa: E402
from app.pipeline.generate import WireBatch, _wire_item, generate_question  # noqa: E402
from app.pipeline.prompts import LEARNER_PRESETS, PROMPT_VERSION  # noqa: E402
from app.pipeline.validate import same_front, validate_item  # noqa: E402


class RecordedTransport:
    def __init__(self, inner):
        self.inner = inner
        self.calls = []

    async def complete(self, **kwargs):
        try:
            response = await self.inner.complete(**kwargs)
        except ProviderError as error:
            self.calls.append(
                {
                    "max_output_tokens": kwargs["max_output_tokens"],
                    "mode": kwargs["mode"],
                    "error": {"code": error.code, "detail": error.detail},
                    "usage": asdict(error.usage) if error.usage is not None else None,
                }
            )
            raise
        call = {
            "max_output_tokens": kwargs["max_output_tokens"],
            "mode": kwargs["mode"],
            "content": response.content,
            "actual_model_id": response.actual_model_id,
            "usage": asdict(response.usage),
        }
        try:
            WireBatch.model_validate_json(clean_json(response.content))
        except ValueError as error:
            call["validation_error"] = str(error)
        self.calls.append(call)
        return response


class RecordedClient(AiClient):
    def __init__(self, model_id):
        self.model_id = model_id
        self.rounds = []
        super().__init__(retry_backoff=(2, 6))
        resolved = self.resolve("generate")
        with session_factory()() as session:
            self.transport = RecordedTransport(production_transport(session, resolved.provider.id))

    def resolve(self, role, request_override=None):
        resolved = super().resolve(role, request_override)
        if resolved.model_id != self.model_id:
            raise RuntimeError(f"Ожидалась {self.model_id}, настроена {resolved.model_id}")
        return resolved

    async def complete(self, **kwargs):
        result = await self.complete_result(**kwargs)
        context = json.loads(
            kwargs["messages"][1]["content"].removeprefix("<context>").removesuffix("</context>")
        )
        audits, accepted = [], []
        for wire in result.value.items:
            dropped = []
            cleaned, issues = validate_item(
                _wire_item(wire),
                context["reference"],
                check_quote=context.get("mode") != "from_card",
                prune=True,
                dropped=dropped,
            )
            if any(same_front(cleaned["prompt"], p) for p in [*context["avoid"], *accepted]):
                issues.append("Повтор формулировки")
            if not issues:
                accepted.append(cleaned["prompt"])
            audits.append({"prompt": cleaned["prompt"], "issues": issues, "dropped": dropped})
        self.rounds.append(
            {
                "messages": kwargs["messages"],
                "response": result.value.model_dump(mode="json"),
                "audit": audits,
                "passed": len(accepted),
                "actual_model_id": result.actual_model_id,
                "usage": asdict(result.usage),
                "duration_ms": result.duration_ms,
                "call_id": result.run_id,
            }
        )
        return result.value


def scenarios(args):
    presets = {p["id"]: p["text"] for p in LEARNER_PRESETS} | {"custom": CUSTOM_PROMPT}
    result = []
    for subject in SUBJECTS:
        if args.subjects and subject["id"] not in args.subjects:
            continue
        for preset in args.presets:
            for repeat in range(args.repeats):
                suffix = f"-repeat-{repeat + 1}" if repeat else ""
                result.append(
                    subject
                    | {
                        "case_id": f"{subject['id']}/{preset}{suffix}",
                        "preset": preset,
                        "target": 3,
                        "learner_prompt": presets[preset],
                    }
                )
        for repeat in range(args.advanced_repeats):
            result.append(
                subject
                | {
                    "case_id": f"{subject['id']}/advanced-repeat-{repeat + 1}",
                    "preset": "advanced",
                    "target": 3,
                    "learner_prompt": presets["advanced"],
                }
            )
    if args.stress:
        for subject in SUBJECTS[:2]:
            result.append(
                subject
                | {
                    "case_id": f"{subject['id']}/no-reference",
                    "preset": "custom",
                    "reference": None,
                    "target": 3,
                    "learner_prompt": CUSTOM_PROMPT,
                }
            )
        result.append(
            {
                "case_id": "mixed/long-reference",
                "subject": "Смешанный материал",
                "question": "Линейная алгебра, оптика и логистический рост: применение моделей",
                "reference": "\n\n".join(
                    s["reference"] for s in [SUBJECTS[0], SUBJECTS[1], SUBJECTS[4]]
                ),
                "preset": "custom",
                "target": 5,
                "learner_prompt": CUSTOM_PROMPT,
            }
        )
        biology = SUBJECTS[4]
        quote = "Абсолютная скорость прироста dN/dt максимальна при N = K/2."
        result.append(
            biology
            | {
                "case_id": "logistic_growth/from-card",
                "preset": "advanced",
                "target": 1,
                "learner_prompt": presets["advanced"],
                "card": {
                    "front": "При какой численности абсолютная скорость прироста максимальна?",
                    "back": quote,
                    "source": "tentex_card",
                },
            }
        )
        result.append(
            biology
            | {
                "case_id": "logistic_growth/distractors",
                "preset": "advanced",
                "target": 1,
                "learner_prompt": presets["advanced"],
                "mode": "distractors",
                "original": {
                    "prompt": "При какой численности абсолютный логистический прирост максимален?",
                    "correct": "$N=K/2$",
                    "explanation": "Максимум равен rK/4.",
                    "source": "user_docs",
                    "evidence_quote": quote,
                },
            }
        )
    return result


def recorded_cost(run_id):
    with session_factory()() as session:
        return session.scalar(
            select(func.coalesce(func.sum(AiCall.cost_usd), 0)).where(AiCall.job_id == run_id)
        )


async def evaluate(args):
    resolved = AiClient().resolve("generate")
    if resolved.model_id != args.model:
        raise RuntimeError(
            f"Роль generate настроена на {resolved.model_id}, ожидалась {args.model}"
        )
    cases = scenarios(args)
    run_id = "qa-" + str(uuid4())
    report = {
        "run_id": run_id,
        "started_at": datetime.now(UTC).isoformat(),
        "prompt_version": PROMPT_VERSION,
        "requested_model": resolved.model_id,
        "provider": resolved.provider.label,
        "max_cost_usd": str(args.max_cost_usd),
        "cost_basis": "API, если стоимость возвращена; иначе цены локального каталога",
        "code_sha256": {
            str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in (ROOT / "backend/app/pipeline").glob("*.py")
        },
        "results": [],
    }
    folder = ROOT / "data" / "qa"
    folder.mkdir(parents=True, exist_ok=True)
    output = args.output or folder / f"haiku-{datetime.now(UTC):%Y%m%dT%H%M%S}.json"
    output.parent.mkdir(parents=True, exist_ok=True)

    def save():
        output.write_text(
            json.dumps(report, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8"
        )

    save()
    print(
        json.dumps(
            {
                "event": "start",
                "cases": len(cases),
                "run_id": run_id,
                "model": resolved.model_id,
                "output": str(output),
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    semaphore = asyncio.Semaphore(args.concurrency)

    async def run_case(case):
        async with semaphore:
            if recorded_cost(run_id) >= args.max_cost_usd:
                report["results"].append({"case_id": case["case_id"], "skipped": "Лимит расходов"})
                save()
                return
            client = RecordedClient(args.model)
            started = monotonic()
            entry = dict(case)
            q = SimpleNamespace(
                id=case["case_id"],
                text=case["question"],
                section=case["subject"],
                answer_text=case["reference"],
                items_target=case["target"],
            )
            try:
                batch = await generate_question(
                    client,
                    q,
                    target=case["target"],
                    job_id=run_id,
                    learner_prompt=case["learner_prompt"],
                    card=case.get("card"),
                    mode=case.get("mode"),
                    original=case.get("original"),
                )
                entry.update(items=batch.items, warnings=batch.warnings, error=batch.error)
            except DomainError as error:
                entry.update(
                    items=[], warnings=[], error={"code": error.code, "detail": error.detail}
                )
            finally:
                await client.transport.inner.client.close()
            entry.update(
                rounds=client.rounds,
                provider_calls=client.transport.calls,
                duration_seconds=round(monotonic() - started, 2),
            )
            report["results"].append(entry)
            report["cost_usd"] = str(recorded_cost(run_id))
            save()
            print(
                json.dumps(
                    {
                        "case": case["case_id"],
                        "created": len(entry["items"]),
                        "target": case["target"],
                        "rounds": len(client.rounds),
                        "seconds": entry["duration_seconds"],
                        "error": entry["error"],
                        "cost_usd": report["cost_usd"],
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )

    await asyncio.gather(*(run_case(case) for case in cases))
    tested = [r for r in report["results"] if "skipped" not in r]
    report["finished_at"] = datetime.now(UTC).isoformat()
    report["summary"] = {
        "cases": len(tested),
        "skipped": len(cases) - len(tested),
        "requested_cards": sum(r["target"] for r in tested),
        "created_cards": sum(len(r["items"]) for r in tested),
        "full_batches": sum(len(r["items"]) == r["target"] for r in tested),
        "rounds": sum(len(r["rounds"]) for r in tested),
        "provider_calls": sum(len(r["provider_calls"]) for r in tested),
        "actual_model_ids": sorted(
            {call["actual_model_id"] for r in tested for call in r["rounds"]}
        ),
    }
    save()
    print(json.dumps(report["summary"], ensure_ascii=False), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true", help="Разрешить реальные платные запросы")
    parser.add_argument("--model", default="claude-haiku-5.5")
    parser.add_argument(
        "--presets",
        nargs="+",
        choices=["beginner", "exam", "advanced", "custom"],
        default=["beginner", "exam", "advanced", "custom"],
    )
    parser.add_argument("--subjects", nargs="+", choices=[s["id"] for s in SUBJECTS])
    parser.add_argument("--advanced-repeats", type=int, default=1)
    parser.add_argument("--repeats", type=int, choices=range(1, 6), default=1)
    parser.add_argument("--stress", action="store_true")
    parser.add_argument("--concurrency", type=int, choices=[1, 2], default=2)
    parser.add_argument("--max-cost-usd", type=Decimal, default=Decimal("0.50"))
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    if not args.live:
        parser.error("Нужен --live: запросы к настроенному провайдеру платные")
    sys.stdout.reconfigure(encoding="utf-8")
    asyncio.run(evaluate(args))


if __name__ == "__main__":
    main()
