"""Перенос снимков вопросов, карточек и ИИ-настроек из Tentex."""

import hashlib
from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ai.credentials import encrypt_secret
from app.ai.models import AiModelCatalogEntry, AiProviderConnection, AiSettings
from app.ai.settings import read_settings, validate_base_url
from app.core.errors import DomainError
from app.models import AppSetting, Deck, GenerationJob, Question, SourceDoc
from app.tentex.reader import TentexReader, clean_answer, json_value, public_id
from app.tentex.schemas import TentexProjectImport, TentexProvidersImport


def _walk_nodes(nodes: list[dict]) -> list[tuple[dict, str | None, str | None]]:
    """Обход дерева: ближайшая тема принимает свои подпункты."""
    node_ids = {node["id"] for node in nodes}
    children = defaultdict(list)
    for node in nodes:
        parent = node.get("parent_id")
        children[parent if parent in node_ids else None].append(node)
    output, visited = [], set()

    def walk(parent, section=None, topic=None):
        for node in children[parent]:
            if node["id"] in visited:
                raise DomainError(
                    422, "tentex_database_invalid", "В дереве программы Tentex обнаружен цикл"
                )
            visited.add(node["id"])
            node_section = node["title"] if node["node_type"] == "section" else section
            node_topic = node["id"] if node["node_type"] == "topic" else topic
            output.append((node, node_section, node_topic))
            walk(node["id"], node_section, node_topic)

    walk(None)
    if len(visited) != len(nodes):
        raise DomainError(
            422, "tentex_database_invalid", "В дереве программы Tentex обнаружен недоступный цикл"
        )
    return output


def import_project(
    session: Session, project_id: str, options: TentexProjectImport, *, force=False
) -> tuple[Deck, GenerationJob]:
    snapshot = TentexReader().project(project_id, force=force)
    program = _walk_nodes(snapshot["nodes"])
    active_ids = {node["id"] for node in snapshot["nodes"]}
    raw_answers = (
        {
            answer["program_node_id"]: clean_answer(answer["text"])
            for answer in snapshot["answers"]
            if answer["program_node_id"] in active_ids
        }
        if options.use_answers
        else {}
    )
    children = defaultdict(list)
    for node, _section, topic in program:
        if node["node_type"] == "subpoint" and topic is not None:
            children[topic].append(node)
    candidates = [node for node, _section, _topic in program if node["node_type"] == "topic"]
    usable_cards = (
        [
            card
            for card in snapshot["cards"]
            if card.get("program_node_id") is None or card["program_node_id"] in active_ids
        ]
        if options.use_cards
        else []
    )
    if not candidates and not usable_cards:
        raise DomainError(
            422, "tentex_project_empty", "В проекте Tentex нет вопросов или активных карточек"
        )
    if len(candidates) > 400:
        raise DomainError(
            422,
            "import_too_many_questions",
            "За один импорт можно перенести не более 400 вопросов",
            {"count": len(candidates)},
        )
    deck = Deck(
        title=options.title or snapshot["project"].get("name") or "Проект Tentex",
        description=snapshot["project"].get("description") or "",
        source_kind="tentex",
        tentex_project_id=public_id(snapshot["project"]["id"]),
        options=options.model_dump(),
    )
    session.add(deck)
    session.flush()
    all_answers = "\n\n".join(raw_answers.values())
    source = None
    if all_answers:
        source = SourceDoc(
            deck_id=deck.id,
            filename="Ответы Tentex",
            kind="paste",
            role="answers",
            sha256=hashlib.sha256(all_answers.encode()).hexdigest(),
            text=all_answers,
            warnings=[],
        )
        session.add(source)
        session.flush()
    questions = {}
    for node, section, _topic in program:
        if node["node_type"] != "topic":
            continue
        subpoints = children[node["id"]]
        answer_parts = [raw_answers[node["id"]]] if raw_answers.get(node["id"]) else []
        for subpoint in subpoints:
            if raw_answers.get(subpoint["id"]):
                answer_parts.append(f"### {subpoint['title']}\n{raw_answers[subpoint['id']]}")
        question = Question(
            deck_id=deck.id,
            ordinal=len(questions) + 1,
            number_label=str(len(questions) + 1),
            section=section,
            text=node["title"]
            + ("\n" + "\n".join(f"• {child['title']}" for child in subpoints) if subpoints else ""),
            answer_text="\n\n".join(answer_parts) or None,
            answer_doc_id=source.id if source and answer_parts else None,
            match_method="tentex",
            tentex_node_id=public_id(node["id"]),
            items_target=None
            if options.items_per_question == "auto"
            else options.items_per_question,
        )
        session.add(question)
        session.flush()
        questions[node["id"]] = question
    child_topics = {node["id"]: topic for node, _section, topic in program}
    cards_by_question = defaultdict(list)
    card_questions = []
    for card in usable_cards:
        node_id = child_topics.get(card.get("program_node_id"))
        question = questions.get(node_id)
        if question is None:
            question = Question(
                deck_id=deck.id,
                ordinal=len(questions) + len(card_questions) + 1,
                number_label=str(len(questions) + len(card_questions) + 1),
                text=clean_answer(card["front"]),
                answer_text=clean_answer(card["back"]) or None,
                match_method="tentex",
                synthetic=True,
                items_target=1,
            )
            session.add(question)
            session.flush()
            card_questions.append(question)
        cards_by_question[question.id].append(
            {
                "front": clean_answer(card["front"]),
                "back": clean_answer(card["back"]),
                "tentex_card_id": public_id(card["id"]),
            }
        )
    total = len(questions) + len(card_questions)
    if total > 400:
        raise DomainError(
            422,
            "import_too_many_questions",
            "За один импорт можно перенести не более 400 вопросов",
            {"count": total},
        )
    deck.options = {**deck.options, "tentex_cards": dict(cards_by_question)}
    job = GenerationJob(deck_id=deck.id, kind="tentex_import", state="queued", total=total)
    session.add(job)
    session.commit()
    return deck, job


def _provider_mapping(session: Session) -> dict:
    row = session.get(AppSetting, "tentex_provider_mapping")
    return dict(row.value) if row and isinstance(row.value, dict) else {}


def _find_imported(session: Session, raw: dict, mapping: dict) -> AiProviderConnection | None:
    mapped = mapping.get(public_id(raw["id"]))
    provider = session.get(AiProviderConnection, mapped) if mapped else None
    if provider is None:
        provider = session.scalar(
            select(AiProviderConnection).where(
                AiProviderConnection.label == raw["label"],
                AiProviderConnection.base_url
                == raw["base_url"].replace("host.docker.internal", "localhost").rstrip("/"),
            )
        )
    return provider


def list_providers(session: Session, *, force=False) -> list[dict]:
    reader = TentexReader()
    snapshot = reader.providers(force=force)
    mapping = _provider_mapping(session)
    output = []
    for provider in snapshot["providers"]:
        has_key = bool(provider.get("api_key_ciphertext"))
        decryptable = not has_key
        if has_key:
            try:
                reader.decrypt_key(provider["api_key_ciphertext"])
                decryptable = True
            except DomainError:
                pass
        output.append(
            {
                "tentex_id": public_id(provider["id"]),
                "label": provider["label"],
                "base_url": provider["base_url"].replace("host.docker.internal", "localhost"),
                "catalog_profile": provider.get("catalog_profile", "openai_compatible"),
                "has_api_key": has_key,
                "decryptable": decryptable,
                "model_count": sum(
                    model["provider_id"] == provider["id"] and bool(model.get("is_available", 1))
                    for model in snapshot["models"]
                ),
                "already_imported": _find_imported(session, provider, mapping) is not None,
            }
        )
    return output


def _model_values(raw: dict) -> dict:
    fields = {column.name for column in AiModelCatalogEntry.__table__.columns} - {"provider_id"}
    values = {key: value for key, value in raw.items() if key in fields}
    for field in ["supported_parameters", "input_modalities", "output_modalities"]:
        values[field] = json_value(values.get(field), [])
    for field in ["reasoning", "default_parameters", "manual_overrides"]:
        values[field] = json_value(values.get(field), {})
    for field in ["prompt_price_usd", "completion_price_usd"]:
        if values.get(field) is not None:
            values[field] = Decimal(str(values[field]))
    for field in ["pricing_snapshot_at", "catalog_snapshot_at"]:
        value = values.get(field)
        values[field] = (
            datetime.fromisoformat(value)
            if isinstance(value, str)
            else value or datetime.now(timezone.utc)
        )
    values["display_name"] = values.get("display_name") or values["model_id"]
    values["is_available"] = bool(values.get("is_available", 1))
    values["is_manually_added"] = bool(values.get("is_manually_added", 0))
    return values


def import_providers(session: Session, options: TentexProvidersImport, *, force=False):
    reader = TentexReader()
    snapshot = reader.providers(force=force)
    selected = set(options.provider_ids) if options.provider_ids is not None else None
    providers = [
        provider
        for provider in snapshot["providers"]
        if selected is None or public_id(provider["id"]) in selected
    ]
    found = {public_id(provider["id"]) for provider in providers}
    if selected is not None and found != selected:
        raise DomainError(404, "tentex_provider_not_found", "Провайдер Tentex не найден")
    # Проверяем все ключи до изменений нашей БД, импорт атомарен.
    keys = {
        provider["id"]: reader.decrypt_key(provider["api_key_ciphertext"])
        if provider.get("api_key_ciphertext")
        else None
        for provider in providers
    }
    mapping = _provider_mapping(session)
    old_to_new = {}
    for raw in providers:
        provider = _find_imported(session, raw, mapping)
        if provider is None:
            label = raw["label"]
            suffix = 1
            while session.scalar(
                select(AiProviderConnection.id).where(AiProviderConnection.label == label)
            ):
                label = f"{raw['label']} (Tentex {suffix})"
                suffix += 1
            provider = AiProviderConnection(
                label=label,
                catalog_profile=raw.get("catalog_profile", "openai_compatible"),
                base_url=validate_base_url(
                    raw["base_url"].replace("host.docker.internal", "localhost")
                ),
                api_key_ciphertext=encrypt_secret(keys[raw["id"]]) if keys[raw["id"]] else None,
                is_favorite=bool(raw.get("is_favorite", False)),
            )
            session.add(provider)
            session.flush()
        elif keys[raw["id"]]:
            provider.api_key_ciphertext = encrypt_secret(keys[raw["id"]])
        old_to_new[raw["id"]] = provider.id
        mapping[public_id(raw["id"])] = provider.id
        if options.include_models:
            for model in snapshot["models"]:
                if model["provider_id"] != raw["id"]:
                    continue
                values = _model_values(model)
                existing = session.get(AiModelCatalogEntry, (provider.id, model["model_id"]))
                if existing is None:
                    session.add(AiModelCatalogEntry(provider_id=provider.id, **values))
                else:
                    for key, value in values.items():
                        setattr(existing, key, value)
    setting = session.get(AppSetting, "tentex_provider_mapping")
    if setting is None:
        session.add(AppSetting(key="tentex_provider_mapping", value=mapping))
    else:
        setting.value = mapping
    session.flush()
    if options.set_default and providers:
        settings = session.get(AiSettings, 1)
        if settings is None:
            settings = AiSettings(id=1)
            session.add(settings)
        old_default = snapshot["settings"].get("default_text_provider_id")
        model_id = snapshot["settings"].get("default_text_model_id")
        provider_id = old_to_new.get(old_default)
        if (
            not provider_id
            or not model_id
            or not session.get(AiModelCatalogEntry, (provider_id, model_id))
        ):
            model = session.scalar(
                select(AiModelCatalogEntry)
                .where(
                    AiModelCatalogEntry.provider_id.in_(list(old_to_new.values())),
                    AiModelCatalogEntry.is_available.is_(True),
                )
                .order_by(AiModelCatalogEntry.model_id)
            )
            provider_id, model_id = (model.provider_id, model.model_id) if model else (None, None)
        if provider_id and model_id:
            settings.default_text_provider_id, settings.default_text_model_id = (
                provider_id,
                model_id,
            )
            settings.external_models_enabled = True
    session.commit()
    return read_settings(session)
