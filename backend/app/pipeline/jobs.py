import asyncio
import hashlib
import logging
from contextlib import nullcontext
from dataclasses import dataclass
from pathlib import Path
from weakref import WeakKeyDictionary

from sqlalchemy import func, select

from app.ai.client import AiClient, estimate_cost
from app.ai.models import AiCall, AiSettings
from app.config import get_settings
from app.core.errors import DomainError, not_found
from app.db import session_factory
from app.decks.service import ACTIVE_STATES, active_job, require_deck
from app.models import Deck, GenerationJob, Question, QuizItem, SourceDoc, uid, utc_now
from app.parsing.classify import classify_documents
from app.parsing.extract import Block, ExtractedDocument, extract_document
from app.pipeline.generate import GeneratedBatch, auto_target, generate_question
from app.pipeline.schemas import JobRead, JobSource
from app.pipeline.structure import structure_documents
from app.pipeline.title import DEFAULT_TITLE, suggest_title, title_from_files
from app.pipeline.validate import same_front

TERMINAL_STATES = ("done", "failed", "cancelled", "interrupted")
_managers = WeakKeyDictionary()


def program_neighbors(session, question) -> dict[str, str | None]:
    """Соседние темы программы: карточки темы связаны с ними, а ловушки берутся из них."""

    def text(order, condition):
        return session.scalar(
            select(Question.text)
            .where(Question.deck_id == question.deck_id, condition)
            .order_by(order)
            .limit(1)
        )

    return {
        "previous": text(Question.ordinal.desc(), Question.ordinal < question.ordinal),
        "next": text(Question.ordinal, Question.ordinal > question.ordinal),
    }


def require_job(session, job_id):
    job = session.get(GenerationJob, job_id)
    if not job:
        raise not_found("Задача не найдена")
    return job


def job_usage(session, job_id):
    calls = list(session.scalars(select(AiCall).where(AiCall.job_id == job_id)))
    return {
        "input_tokens": sum(c.input_tokens for c in calls),
        "output_tokens": sum(c.output_tokens for c in calls),
        "cost_usd": None
        if any(c.cost_usd is None for c in calls)
        else float(sum(c.cost_usd for c in calls)),
    }


def job_sources(session, job):
    """Файлы задачи с ролями: выбранными при загрузке или найденными при разборе."""
    deck = session.get(Deck, job.deck_id)
    config = deck.options.get("imports", {}).get(job.id, {}) if deck else {}
    ids = config.get("doc_ids", [])
    if not ids:
        return []
    chosen = config.get("roles") or {}
    detected = config.get("detected_roles") or {}
    sources = {s.id: s for s in session.scalars(select(SourceDoc).where(SourceDoc.id.in_(ids)))}
    return [
        JobSource(
            filename=source.filename,
            # До разбора в SourceDoc.role лежит заглушка «notes», поэтому верим ей только после.
            role=chosen.get(source.filename)
            or detected.get(source.id)
            or (source.role if job.total else None),
        )
        for source in (sources.get(id) for id in ids)
        if source
    ]


def job_read(session, job):
    ready_items = session.scalar(
        select(func.count())
        .select_from(QuizItem)
        .where(QuizItem.deck_id == job.deck_id, QuizItem.enabled)
    )
    failed = session.scalar(
        select(func.count())
        .select_from(Question)
        .where(Question.deck_id == job.deck_id, Question.status == "failed")
    )
    labels = {
        "queued": "В очереди",
        "extracting": "Читаю файлы",
        "structuring": "Разбираю материал",
        "awaiting_confirm": "Нужно подтверждение стоимости",
        "awaiting_executor": "Ожидаю ответ модели через MCP",
        "done": "Карточки готовы",
        "failed": "Не удалось завершить генерацию",
        "cancelled": "Генерация отменена",
        "interrupted": "Генерация прервана; можно продолжить",
    }
    stage = (
        f"Карточки: {job.ready_items}, вопросы {job.done} из {job.total}"
        if job.state == "generating"
        else labels[job.state]
    )
    if job.state == "structuring":
        completed_calls = session.scalar(
            select(func.count())
            .select_from(AiCall)
            .where(AiCall.job_id == job.id, AiCall.role == "extract", AiCall.status == "succeeded")
        )
        if completed_calls:
            stage += f" · выполнено запросов: {completed_calls}"
    can_play = ready_items >= get_settings().min_playable_items or (
        job.state in TERMINAL_STATES and ready_items > 0
    )
    return JobRead(
        **{
            k: getattr(job, k)
            for k in (
                "id",
                "deck_id",
                "kind",
                "state",
                "done",
                "total",
                "warnings",
                "error",
                "estimate",
                "created_at",
                "finished_at",
            )
        },
        ready_items=ready_items,
        failed_questions=failed,
        can_play=can_play,
        stage_label=stage,
        usage=job_usage(session, job.id),
        sources=job_sources(session, job),
    )


def persist_import(documents, options, *, models=None):
    models = snapshot_models() if models is None else models
    with session_factory()() as session:
        if options.deck_id:
            deck = require_deck(session, options.deck_id)
            if active_job(session, deck.id):
                raise DomainError(409, "job_state_conflict", "В этой колоде уже идёт генерация")
        else:
            # Без названия от пользователя: сначала имя файла, после разбора вопросов — от модели.
            title = (
                options.title or title_from_files([d.filename for d in documents]) or DEFAULT_TITLE
            )
            deck = Deck(
                id=uid(),
                title=title,
                source_kind="upload",
                options={"auto_title": title} if options.auto_title and not options.title else {},
            )
            session.add(deck)
            session.flush()
        config = dict(deck.options)
        if options.learner_prompt and options.learner_prompt.strip():
            # Пожелания живут в колоде: перегенерация вопроса и карточки учитывает их же.
            config["learner_prompt"] = options.learner_prompt.strip()
        ids = []
        for document in documents:
            ids.append(document.id)
            session.add(
                SourceDoc(
                    id=document.id,
                    deck_id=deck.id,
                    filename=document.filename,
                    kind=document.kind,
                    role=document.role or "notes",
                    text=document.text,
                    sha256=document.sha256 or hashlib.sha256(document.text.encode()).hexdigest(),
                    warnings=document.warnings,
                    blocks=[
                        {
                            "text": b.text,
                            "element_kind": b.element_kind,
                            "page": b.page,
                            "level": b.level,
                        }
                        for b in document.blocks
                    ],
                )
            )
        job_id = uid()
        imports = dict(config.get("imports", {}))
        imports[job_id] = {
            "models": models,
            "doc_ids": ids,
            "roles": options.roles,
            "items_per_question": options.items_per_question,
            "confirmed": options.confirm_cost,
            "upload_paths": {d.id: d.upload_path for d in documents if d.upload_path},
        }
        deck.options = config | {"imports": imports}
        job = GenerationJob(
            id=job_id,
            deck_id=deck.id,
            kind="quick_import",
            warnings=[w for d in documents for w in d.warnings],
        )
        session.add(job)
        session.commit()
        return deck.id, job.id


def snapshot_models():
    """Фиксируем модели задачи; подписка не вызывает API на промежуточных этапах."""
    client = AiClient()
    generate = client.resolve("generate")
    chosen = {"provider_id": generate.provider.id, "model_id": generate.model_id}
    try:
        extract = client.resolve("extract")
        extracted = {"provider_id": extract.provider.id, "model_id": extract.model_id}
        if generate.is_subscription and not extract.is_subscription:
            extracted = chosen
    except DomainError:
        extracted = None
    return {"generate": chosen, "extract": extracted}


def create_question_job(session, deck_id, question_id, target=None):
    deck = require_deck(session, deck_id)
    if active_job(session, deck_id):
        raise DomainError(409, "job_state_conflict", "В колоде уже есть активная задача")
    question = session.get(Question, question_id)
    if not question or question.deck_id != deck_id:
        raise not_found("Вопрос не найден в этой колоде")
    job = GenerationJob(id=uid(), deck_id=deck.id, kind="regen_question", total=1)
    config = dict(deck.options)
    imports = dict(config.get("imports", {}))
    imports[job.id] = {
        "models": snapshot_models(),
        "question_ids": [question.id],
        "items_per_question": target or "auto",
        "confirmed": False,
    }
    deck.options = config | {"imports": imports}
    question.status, question.error = "pending", None
    if target and target != "auto":
        question.items_target = target
    elif target == "auto":
        question.items_target = None
    session.add(job)
    session.commit()
    return job.id


def _load_documents(session, deck, config):
    ids = config.get("doc_ids", [])
    docs = []
    for source in session.scalars(select(SourceDoc).where(SourceDoc.id.in_(ids))):
        values = source.blocks or deck.options.get("source_blocks", {}).get(source.id, [])
        blocks = [Block(**value) for value in values]
        doc = ExtractedDocument(
            id=source.id,
            filename=source.filename,
            kind=source.kind,
            text=source.text,
            blocks=blocks,
            role=config.get("roles", {}).get(source.filename),
            warnings=source.warnings,
        )
        docs.append(doc)
    order = {id: i for i, id in enumerate(ids)}
    return sorted(docs, key=lambda d: order[d.id])


def _estimate(session, questions, client):
    resolved = client.resolve("generate")
    input_tokens = sum(
        len((q.text + (q.answer_text or "")).encode()) // 3 + 1600 for q in questions
    )
    output_tokens = sum((q.items_target or auto_target(q.answer_text)) * 550 for q in questions)
    cost = estimate_cost(input_tokens, output_tokens, resolved)
    settings = session.get(AiSettings, 1)
    cost_limit = settings.confirm_cost_usd if settings else get_settings().confirm_cost_usd
    token_limit = settings.confirm_input_tokens if settings else get_settings().confirm_input_tokens
    reasons = []
    if cost_limit is not None and cost is not None and cost >= cost_limit:
        reasons.append("Стоимость генерации превышает порог подтверждения")
    if input_tokens >= token_limit:
        reasons.append("Большой объём входных токенов")
    if cost is None and not resolved.is_subscription and len(questions) > 150:
        reasons.append("Цена модели неизвестна; найдено более 150 вопросов")
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "cost_usd": float(cost) if cost is not None else None,
        "requires_confirm": bool(reasons),
        "reasons": reasons,
    }


def _merge_warnings(existing, added):
    values = [dict(w) for w in existing]
    for warning in added:
        match = next(
            (
                w
                for w in values
                if w["code"] == warning["code"]
                and "count" in w.get("context", {})
                and "count" in warning.get("context", {})
            ),
            None,
        )
        if match:
            match["context"] = dict(match["context"])
            match["context"]["count"] += warning["context"]["count"]
        else:
            values.append(warning)
    return values


@dataclass
class WriteRequest:
    job_id: str
    question_id: str
    batch: GeneratedBatch
    future: asyncio.Future


class BoundClient:
    def __init__(self, client, job_id):
        self.client, self.job_id = client, job_id
        if hasattr(client, "bind_job"):
            client.bind_job(job_id)

    async def complete(self, **kwargs):
        with session_factory()() as session:
            settings = session.get(AiSettings, 1)
            hard_limit = (
                settings.operation_limit_usd if settings else get_settings().operation_limit_usd
            )
            spent = (
                session.scalar(
                    select(func.sum(AiCall.cost_usd)).where(AiCall.job_id == self.job_id)
                )
                or 0
            )
            if (
                hard_limit is not None
                and spent >= hard_limit
                and not self.resolve(kwargs["role"]).is_subscription
            ):
                raise DomainError(
                    409, "ai_operation_limit", "Достигнут лимит стоимости этой операции"
                )
        kwargs.setdefault("job_id", self.job_id)
        return await self.client.complete(**kwargs)

    def resolve(self, *args, **kwargs):
        return self.client.resolve(*args, **kwargs)


class LimitedExtractClient:
    def __init__(self, client, manager):
        self.client, self.manager = client, manager

    async def complete(self, **kwargs):
        resolved = self.resolve(kwargs["role"])
        local = resolved.serial_execution
        slot = (
            self.manager.subscription_jobs.setdefault(self.client.job_id, asyncio.Semaphore(2))
            if getattr(resolved, "is_subscription", False)
            else nullcontext()
        )
        async with slot, self.manager.local if local else self.manager.cloud:
            return await self.client.complete(**kwargs)

    def resolve(self, *args, **kwargs):
        return self.client.resolve(*args, **kwargs)


class JobManager:
    def __init__(self):
        self.tasks = {}
        self.subscription_jobs = {}
        self.cloud = asyncio.Semaphore(get_settings().concurrency)
        self.local = asyncio.Semaphore(1)
        self.queue = asyncio.Queue()
        self.writer = None
        self.stopping = False

    def start(self, job_id):
        if job_id in self.tasks and not self.tasks[job_id].done():
            return self.tasks[job_id]
        if self.writer is None or self.writer.done():
            self.writer = asyncio.create_task(self._writer())
        task = asyncio.create_task(self._run(job_id), name=f"generation-{job_id}")
        self.tasks[job_id] = task

        def cleanup(finished):
            if self.tasks.get(job_id) is finished:
                self.tasks.pop(job_id, None)
                self.subscription_jobs.pop(job_id, None)

        task.add_done_callback(cleanup)
        return task

    async def _writer(self):
        while True:
            request = await self.queue.get()
            try:
                if request.future.cancelled():
                    continue
                with session_factory()() as session:
                    job = session.get(GenerationJob, request.job_id)
                    if not job or job.cancel_requested or self.stopping:
                        continue
                    question = session.get(Question, request.question_id)
                    deck = session.get(Deck, job.deck_id)
                    if not question or not deck:
                        continue
                    existing = list(
                        session.scalars(select(QuizItem.prompt).where(QuizItem.deck_id == deck.id))
                    )
                    current = (
                        session.scalar(
                            select(func.max(QuizItem.seq)).where(QuizItem.deck_id == deck.id)
                        )
                        or 0
                    )
                    high_water = max(current, deck.options.get("seq_high_water", 0))
                    count = 0
                    for item in request.batch.items:
                        if any(same_front(item["prompt"], p) for p in existing):
                            continue
                        high_water += 1
                        session.add(
                            QuizItem(
                                id=uid(),
                                deck_id=deck.id,
                                question_id=question.id,
                                seq=high_water,
                                **item,
                            )
                        )
                        existing.append(item["prompt"])
                        count += 1
                    deck.options = dict(deck.options) | {"seq_high_water": high_water}
                    deck.updated_at = utc_now()
                    question.status = "done" if count else "failed"
                    question.error = (
                        None
                        if count
                        else request.batch.error or "Модель не создала новых валидных карточек"
                    )
                    job.done += 1
                    job.ready_items += count
                    job.warnings = _merge_warnings(job.warnings, request.batch.warnings)
                    job.usage = job_usage(session, job.id)
                    session.commit()
            except Exception as exc:
                if not request.future.done():
                    request.future.set_exception(exc)
            finally:
                if not request.future.done():
                    request.future.set_result(None)
                self.queue.task_done()

    async def _question(self, job_id, question_id, cards, learner_prompt=None):
        client = BoundClient(AiClient(), job_id)
        resolved = client.resolve("generate")
        local = resolved.serial_execution
        slot = (
            self.subscription_jobs.setdefault(job_id, asyncio.Semaphore(2))
            if resolved.is_subscription
            else nullcontext()
        )
        async with slot, self.local if local else self.cloud:
            with session_factory()() as session:
                job = require_job(session, job_id)
                if job.cancel_requested:
                    return
                question = session.get(Question, question_id)
                question.status = "generating"
                question.error = None
                avoid = list(
                    session.scalars(select(QuizItem.prompt).where(QuizItem.deck_id == job.deck_id))
                )
                neighbors = program_neighbors(session, question)
                session.commit()
                session.expunge(question)
                limits = session.get(AiSettings, 1)
                hard_limit = (
                    limits.operation_limit_usd if limits else get_settings().operation_limit_usd
                )
                usage = job_usage(session, job_id)
                if (
                    hard_limit is not None
                    and not resolved.is_subscription
                    and usage["cost_usd"] is not None
                    and usage["cost_usd"] >= hard_limit
                ):
                    raise DomainError(
                        409, "ai_operation_limit", "Достигнут лимит стоимости этой операции"
                    )
            try:
                if cards:
                    batch = GeneratedBatch([], [])
                    for card in cards:
                        generated = await generate_question(
                            client,
                            question,
                            card=card,
                            avoid=avoid,
                            job_id=job_id,
                            learner_prompt=learner_prompt,
                        )
                        batch.items.extend(generated.items)
                        batch.warnings.extend(generated.warnings)
                        avoid.extend(i["prompt"] for i in generated.items)
                        batch.error = generated.error
                else:
                    batch = await generate_question(
                        client,
                        question,
                        avoid=avoid,
                        job_id=job_id,
                        learner_prompt=learner_prompt,
                        neighbors=neighbors,
                    )
            except DomainError as exc:
                if exc.code in (
                    "ai_invalid_credentials",
                    "ai_operation_limit",
                    "ai_disabled",
                    "ai_role_disabled",
                ) or exc.code.startswith("ai_subscription_"):
                    raise
                batch = GeneratedBatch([], [], exc.detail)
            future = asyncio.get_running_loop().create_future()
            await self.queue.put(WriteRequest(job_id, question_id, batch, future))
            await future

    async def _title(self, job_id, deck_id, filenames, questions):
        """Название от модели; ошибка здесь не мешает генерации карточек."""
        try:
            title = await suggest_title(
                LimitedExtractClient(BoundClient(AiClient(), job_id), self),
                filenames=filenames,
                sections=[q.section for q in questions],
                questions=[q.text for q in questions],
                job_id=job_id,
            )
        except asyncio.CancelledError:
            raise
        except Exception:
            logging.getLogger("study_surfers").warning(
                "Не удалось придумать название колоды %s", deck_id, exc_info=True
            )
            return
        if not title:
            return
        with session_factory()() as session:
            deck = session.get(Deck, deck_id)
            # Пользователь успел переименовать колоду — его название не трогаем.
            if not deck or deck.options.get("auto_title") != deck.title:
                return
            deck.title = title
            deck.options = {k: v for k, v in deck.options.items() if k != "auto_title"}
            deck.updated_at = utc_now()
            session.commit()

    async def _run(self, job_id):
        workers = []
        try:
            with session_factory()() as session:
                job = require_job(session, job_id)
                deck = require_deck(session, job.deck_id)
                config = deck.options.get("imports", {}).get(job_id, {})
                learner_prompt = deck.options.get("learner_prompt")
                if "models" not in config:
                    config = dict(config) | {"models": snapshot_models()}
                    imports = dict(deck.options.get("imports", {}))
                    imports[job_id] = config
                    deck.options = dict(deck.options) | {"imports": imports}
                job.started_at = job.started_at or utc_now()
                job.state = "extracting"
                documents = _load_documents(session, deck, config)
                if sum(len(d.text) for d in documents) > 2_000_000 and not config.get("confirmed"):
                    job.state = "awaiting_confirm"
                    job.estimate = {
                        "input_tokens": sum(len(d.text.encode()) // 3 for d in documents),
                        "output_tokens": 0,
                        "cost_usd": None,
                        "requires_confirm": True,
                        "reasons": ["Документы содержат более 2 млн символов"],
                    }
                    session.commit()
                    return
                needs_structure = job.total == 0 and bool(documents)
                session.commit()
            for index, document in enumerate(documents):
                path_value = config.get("upload_paths", {}).get(document.id)
                if not path_value or document.blocks or document.text:
                    continue
                path = Path(path_value).resolve()
                uploads = (get_settings().data_dir / "uploads").resolve()
                if not path.is_relative_to(uploads):
                    raise DomainError(
                        422, "import_file_invalid", "Исходный файл находится вне папки загрузок"
                    )
                try:
                    read = asyncio.create_task(asyncio.to_thread(path.read_bytes))
                    try:
                        data = await asyncio.shield(read)
                    except BaseException:
                        # На Windows удаление ждёт закрытия файла потоком чтения.
                        await asyncio.gather(read, return_exceptions=True)
                        raise
                except OSError as exc:
                    raise DomainError(
                        422,
                        "import_file_invalid",
                        "Не удалось прочитать сохранённый исходный файл",
                        {"filename": document.filename},
                    ) from exc
                extracted = await asyncio.to_thread(
                    extract_document, document.filename, data, document.role
                )
                extracted.id = document.id
                documents[index] = extracted
                with session_factory()() as session:
                    source = session.get(SourceDoc, document.id)
                    source.text, source.warnings = extracted.text, extracted.warnings
                    source.blocks = [
                        {
                            "text": b.text,
                            "element_kind": b.element_kind,
                            "page": b.page,
                            "level": b.level,
                        }
                        for b in extracted.blocks
                    ]
                    job = require_job(session, job_id)
                    job.warnings = _merge_warnings(job.warnings, extracted.warnings)
                    session.commit()
            with session_factory()() as session:
                job = require_job(session, job_id)
                if sum(len(d.text) for d in documents) > 2_000_000 and not config.get("confirmed"):
                    job.state = "awaiting_confirm"
                    job.estimate = {
                        "input_tokens": sum(len(d.text.encode()) // 3 for d in documents),
                        "output_tokens": 0,
                        "cost_usd": None,
                        "requires_confirm": True,
                        "reasons": ["Документы содержат более 2 млн символов"],
                    }
                    session.commit()
                    return
                job.state = "structuring" if needs_structure else "generating"
                session.commit()
            if needs_structure:
                extract = BoundClient(AiClient(), job_id)
                try:
                    extract.resolve("extract")
                except DomainError:
                    extract = None
                ai_client = (
                    LimitedExtractClient(BoundClient(extract, job_id), self) if extract else None
                )
                # Роли нужны экрану прогресса сразу, а не после всего разбора.
                await classify_documents(documents, ai_client=ai_client)
                with session_factory()() as session:
                    deck = require_deck(session, require_job(session, job_id).deck_id)
                    imports = dict(deck.options.get("imports", {}))
                    config = dict(config) | {"detected_roles": {d.id: d.role for d in documents}}
                    imports[job_id] = config
                    deck.options = dict(deck.options) | {"imports": imports}
                    session.commit()
                # Пожелания решают и то, какие темы выделить: «только контрольные вопросы».
                questions = await structure_documents(
                    documents, ai_client=ai_client, learner_prompt=learner_prompt
                )
                if len(questions) > 400:
                    raise DomainError(
                        422,
                        "import_question_limit",
                        "В одном импорте допускается не более 400 вопросов",
                    )
                if not questions:
                    raise DomainError(
                        422,
                        "import_no_questions",
                        "В документах не найдены вопросы или учебный материал",
                    )
                with session_factory()() as session:
                    job = require_job(session, job_id)
                    ordinal = (
                        session.scalar(
                            select(func.max(Question.ordinal)).where(
                                Question.deck_id == job.deck_id
                            )
                        )
                        or 0
                    )
                    ids = []
                    for document in documents:
                        session.get(SourceDoc, document.id).role = document.role
                    for q in questions:
                        ids.append(q.id)
                        target = config.get("items_per_question", "auto")
                        session.add(
                            Question(
                                id=q.id,
                                deck_id=job.deck_id,
                                ordinal=ordinal + q.ordinal,
                                number_label=q.number_label,
                                section=q.section,
                                text=q.text,
                                answer_text=q.answer_text,
                                answer_doc_id=q.answer_doc_id,
                                match_method=q.match_method,
                                synthetic=q.synthetic,
                                key_points=q.key_points or None,
                                items_target=target if target != "auto" else None,
                            )
                        )
                    deck = require_deck(session, job.deck_id)
                    if deck.options.get("auto_title") == deck.title:
                        # Название придумывается параллельно с карточками и отменяется вместе с ними.
                        workers.append(
                            asyncio.create_task(
                                self._title(
                                    job_id, deck.id, [d.filename for d in documents], questions
                                ),
                                name=f"title-{job_id}",
                            )
                        )
                    imports = dict(deck.options.get("imports", {}))
                    config = dict(config) | {"question_ids": ids}
                    imports[job_id] = config
                    deck.options = dict(deck.options) | {"imports": imports}
                    job.total = len(questions)
                    missing = sum(q.answer_text is None for q in questions)
                    if missing:
                        job.warnings = _merge_warnings(
                            job.warnings,
                            [
                                {
                                    "code": "questions_without_answer",
                                    "message": "Для части вопросов нет ответов; используем знания модели",
                                    "context": {"count": missing},
                                }
                            ],
                        )
                    session.commit()
            with session_factory()() as session:
                job = require_job(session, job_id)
                deck = require_deck(session, job.deck_id)
                selection = select(Question).where(Question.deck_id == job.deck_id)
                if config.get("question_ids"):
                    selection = selection.where(Question.id.in_(config["question_ids"]))
                all_questions = list(session.scalars(selection.order_by(Question.ordinal)))
                pending = [q for q in all_questions if q.status != "done"]
                job.total = len(all_questions)
                job.done = sum(q.status == "done" for q in all_questions)
                job.ready_items = session.scalar(
                    select(func.count())
                    .select_from(QuizItem)
                    .where(QuizItem.deck_id == deck.id, QuizItem.enabled)
                )
                estimate = _estimate(session, pending, BoundClient(AiClient(), job_id))
                if config.get("confirmed"):
                    estimate["requires_confirm"] = False
                job.estimate = estimate
                if estimate["requires_confirm"] and not config.get("confirmed"):
                    job.state = "awaiting_confirm"
                    session.commit()
                    return
                job.state = "generating"
                cards = deck.options.get("tentex_cards", {})
                learner_prompt = deck.options.get("learner_prompt")
                ids = [q.id for q in pending]
                session.commit()
            workers.extend(
                asyncio.create_task(self._question(job_id, qid, cards.get(qid, []), learner_prompt))
                for qid in ids
            )
            await asyncio.gather(*workers)
            with session_factory()() as session:
                job = require_job(session, job_id)
                job.state = "done" if job.ready_items else "failed"
                if job.state == "failed":
                    job.error = {
                        "code": "generation_empty",
                        "detail": "Не удалось создать валидные карточки",
                    }
                job.usage, job.finished_at = job_usage(session, job_id), utc_now()
                session.commit()
        except asyncio.CancelledError:
            for worker in workers:
                worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            self._finish_error(job_id, "interrupted" if self.stopping else "cancelled")
            raise
        except Exception as exc:
            logging.getLogger("study_surfers").exception("Ошибка задачи %s", job_id)
            for worker in workers:
                worker.cancel()
            await asyncio.gather(*workers, return_exceptions=True)
            error = {
                "code": exc.code if isinstance(exc, DomainError) else "generation_failed",
                "detail": exc.detail
                if isinstance(exc, DomainError)
                else "Не удалось завершить генерацию",
            }
            self._finish_error(job_id, "failed", error)

    def _finish_error(self, job_id, state, error=None):
        with session_factory()() as session:
            job = session.get(GenerationJob, job_id)
            if not job:
                return
            job.state, job.error, job.finished_at = state, error, utc_now()
            job.usage = job_usage(session, job_id)
            for question in session.scalars(
                select(Question).where(
                    Question.deck_id == job.deck_id, Question.status == "generating"
                )
            ):
                question.status = "pending"
            session.commit()

    async def cancel(self, job_id):
        with session_factory()() as session:
            job = require_job(session, job_id)
            if job.state not in ACTIVE_STATES:
                raise DomainError(409, "job_state_conflict", "Эту задачу сейчас нельзя отменить")
            job.cancel_requested = True
            session.commit()
        task = self.tasks.get(job_id)
        if task:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        self._finish_error(job_id, "cancelled")

    async def close(self):
        self.stopping = True
        tasks = list(self.tasks.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.writer:
            self.writer.cancel()
            await asyncio.gather(self.writer, return_exceptions=True)


def get_manager():
    loop = asyncio.get_running_loop()
    if loop not in _managers:
        _managers[loop] = JobManager()
    return _managers[loop]


def start_job(job_id):
    return get_manager().start(job_id)


async def cancel_job(job_id):
    await get_manager().cancel(job_id)


def recover_jobs():
    with session_factory()() as session:
        for job in session.scalars(
            select(GenerationJob).where(
                GenerationJob.state.in_(
                    ("queued", "extracting", "structuring", "awaiting_executor", "generating")
                )
            )
        ):
            job.state = "interrupted"
            job.finished_at = utc_now()
        for question in session.scalars(select(Question).where(Question.status == "generating")):
            question.status = "pending"
        session.commit()


def transition_job(job_id, action):
    with session_factory()() as session:
        job = require_job(session, job_id)
        allowed = (
            ("awaiting_confirm",) if action == "confirm" else ("interrupted", "cancelled", "failed")
        )
        if job.state not in allowed:
            raise DomainError(
                409, "job_state_conflict", "Действие недоступно в текущем состоянии задачи"
            )
        deck = require_deck(session, job.deck_id)
        other = active_job(session, deck.id)
        if other and other.id != job.id:
            raise DomainError(409, "job_state_conflict", "В колоде уже есть другая активная задача")
        config = dict(deck.options.get("imports", {}).get(job_id, {}))
        if action == "confirm":
            config["confirmed"] = True
            if job.estimate:
                job.estimate = dict(job.estimate) | {"requires_confirm": False}
        imports = dict(deck.options.get("imports", {}))
        imports[job_id] = config
        deck.options = dict(deck.options) | {"imports": imports}
        job.state, job.cancel_requested, job.finished_at, job.error = "queued", False, None, None
        for question in session.scalars(
            select(Question).where(
                Question.deck_id == job.deck_id,
                Question.status.in_(("pending", "failed", "generating")),
            )
        ):
            if not config.get("question_ids") or question.id in config["question_ids"]:
                question.status = "pending"
        session.commit()
