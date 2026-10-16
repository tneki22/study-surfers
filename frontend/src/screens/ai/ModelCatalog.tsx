import { Check, Plus, Search, Star, Trash2, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { api } from "../../api/client";
import type { AiCatalogModel, AiModelTest, AiSettings } from "../../api/types";
import { Button, IconButton, StatusBadge } from "../../components/ui";

type Run = <T>(key: string, action: () => Promise<T>) => Promise<T | null>;

const price = (value: string | null | undefined) => {
  if (!value) return null;
  const perMillion = Number(value) * 1_000_000;
  return Number.isFinite(perMillion) ? `$${perMillion < 1 ? perMillion.toFixed(2) : perMillion.toFixed(1)}` : null;
};

/**
 * Модели одного подключения: добавленные (с выбором «по умолчанию» и проверкой),
 * поиск по каталогу провайдера и ручной ввод id — для локальных серверов,
 * у которых каталога может не быть.
 */
export function ModelCatalog({ providerId, settings, busy, run }: {
  providerId: string;
  settings: AiSettings;
  busy: string | null;
  run: Run;
}) {
  const [catalog, setCatalog] = useState<AiCatalogModel[] | null>(null);
  const [query, setQuery] = useState("");
  const [manual, setManual] = useState("");
  const [tests, setTests] = useState<Record<string, AiModelTest | string>>({});

  const kind = settings.providers.find((p) => p.id === providerId)?.executor_kind;
  const subscription = kind === "codex" || kind === "claude";
  const added = settings.models.filter((model) => model.provider_id === providerId && model.is_available);
  const isDefault = (modelId: string) => settings.default_text?.provider_id === providerId && settings.default_text.model_id === modelId;
  const addedIds = new Set(added.map((model) => model.model_id));

  const found = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return (catalog ?? [])
      .filter((model) => words.every((word) => `${model.model_id} ${model.display_name}`.toLowerCase().includes(word)))
      .slice(0, 40);
  }, [catalog, query]);

  const add = (model: AiCatalogModel) => run(`add:${model.model_id}`, async () => {
    const { is_added: _skip, ...write } = model;
    let next = await api.ai.addModel(providerId, write);
    // Первая модель сразу становится моделью по умолчанию — без лишнего клика.
    if (!next.default_text) next = await api.ai.setDefault({ provider_id: providerId, model_id: model.model_id });
    return next;
  });

  const test = async (modelId: string) => {
    const result = await run(`test:${modelId}`, () => api.ai.testModel(providerId, modelId));
    setTests((current) => ({ ...current, [modelId]: result ?? "не ответила" }));
  };

  return (
    <div className="model-catalog">
      {added.length > 0 && (
        <ul className="model-list">
          {added.map((model) => {
            const result = tests[model.model_id];
            return (
              <li key={model.model_id} className={`model-row ${isDefault(model.model_id) ? "is-default" : ""}`.trim()}>
                <button
                  type="button"
                  className="model-default"
                  aria-pressed={isDefault(model.model_id)}
                  title="Сделать моделью по умолчанию"
                  onClick={() => run(`default:${model.model_id}`, () => api.ai.setDefault({ provider_id: providerId, model_id: model.model_id }))}
                >
                  <Star size={16} aria-hidden="true" fill={isDefault(model.model_id) ? "currentColor" : "none"} />
                </button>
                <span className="model-name">
                  <strong>{model.display_name}</strong>
                  {model.display_name !== model.model_id && <small>{model.model_id}</small>}
                </span>
                {isDefault(model.model_id) && <StatusBadge tone="success">по умолчанию</StatusBadge>}
                {result && (
                  typeof result === "string"
                    ? <StatusBadge tone="danger">{result}</StatusBadge>
                    : <StatusBadge tone="success"><Check size={12} aria-hidden="true" /> {(result.duration_ms / 1000).toFixed(1)} с</StatusBadge>
                )}
                <Button variant="ghost" disabled={busy === `test:${model.model_id}`} onClick={() => test(model.model_id)}>
                  <Zap size={15} aria-hidden="true" /> {busy === `test:${model.model_id}` ? "Спрашиваю…" : "Проверить"}
                </Button>
                <IconButton label={`Убрать ${model.display_name}`} onClick={() => run(`remove:${model.model_id}`, () => api.ai.removeModel(providerId, model.model_id))}>
                  <Trash2 size={15} />
                </IconButton>
              </li>
            );
          })}
        </ul>
      )}

      {subscription ? <p className="screen-hint">Звёздочка выбирает модель для новых колод. «Проверить» отправляет короткий запрос и расходует немного лимита подписки. Чтобы получить актуальный список, нажмите «Обновить модели» в разделе подписок.</p> : <div className="model-search">
        {catalog === null ? (
          <Button variant="secondary" disabled={busy === "catalog"} onClick={async () => setCatalog(await run("catalog", () => api.ai.searchModels(providerId)) ?? [])}>
            <Search size={16} aria-hidden="true" /> {busy === "catalog" ? "Загружаю каталог…" : "Выбрать модель из каталога"}
          </Button>
        ) : (
          <>
            <input type="search" placeholder="Поиск: gemini, gpt, qwen…" value={query} onChange={(event) => setQuery(event.target.value)} autoFocus />
            <ul className="catalog-list">
              {found.map((model) => (
                <li key={model.model_id}>
                  <span className="model-name">
                    <strong>{model.display_name}</strong>
                    {(model.display_name !== model.model_id || price(model.prompt_price_usd)) && (
                      <small>
                        {model.display_name !== model.model_id && model.model_id}
                        {price(model.prompt_price_usd) && ` · ${price(model.prompt_price_usd)} / ${price(model.completion_price_usd)} за 1М токенов`}
                      </small>
                    )}
                  </span>
                  {addedIds.has(model.model_id) ? (
                    <StatusBadge tone="neutral">добавлена</StatusBadge>
                  ) : (
                    <Button variant="ghost" disabled={busy === `add:${model.model_id}`} onClick={() => add(model)}>
                      <Plus size={15} aria-hidden="true" /> Добавить
                    </Button>
                  )}
                </li>
              ))}
              {catalog.length === 0 && <li className="catalog-empty">Каталог пуст — впишите id модели вручную ниже.</li>}
            </ul>
          </>
        )}
        <form
          className="model-manual"
          onSubmit={(event) => {
            event.preventDefault();
            const id = manual.trim();
            if (!id) return;
            void run(`manual:${id}`, async () => {
              let next = await api.ai.addManualModel(providerId, { model_id: id, display_name: id.split("/").pop() ?? id });
              if (!next.default_text) next = await api.ai.setDefault({ provider_id: providerId, model_id: id });
              return next;
            }).then((next) => next && setManual(""));
          }}
        >
          <input placeholder="или id модели вручную, например qwen3-8b" value={manual} onChange={(event) => setManual(event.target.value)} />
          <Button type="submit" variant="ghost" disabled={!manual.trim()}><Plus size={15} aria-hidden="true" /> Добавить</Button>
        </form>
      </div>}
    </div>
  );
}
