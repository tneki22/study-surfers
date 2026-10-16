/*
 * Настройки ИИ в mock-режиме: подключения и модели живут в памяти вкладки,
 * «каталог» провайдера — несколько выдуманных моделей. Нужен, чтобы экран
 * настроек можно было собрать и проверить без сервера.
 */
import type { AiApi } from "./ai";
import { ApiError } from "./http";
import type { AiCatalogModel, AiModel, AiPreset, AiProvider, AiSettings } from "./types";

const PRESETS: AiPreset[] = [
  { key: "openrouter", label: "OpenRouter", base_url: "https://openrouter.ai/api/v1", catalog_profile: "openrouter", requires_key: true, key_hint: "Ключ из личного кабинета OpenRouter" },
  { key: "openai", label: "OpenAI", base_url: "https://api.openai.com/v1", catalog_profile: "openai_compatible", requires_key: true, key_hint: "Ключ OpenAI API" },
  { key: "lmstudio", label: "LM Studio", base_url: "http://localhost:1234/v1", catalog_profile: "openai_compatible", requires_key: false, key_hint: "Включите локальный сервер LM Studio" },
  { key: "ollama", label: "Ollama", base_url: "http://localhost:11434/v1", catalog_profile: "openai_compatible", requires_key: false, key_hint: "Для длинных материалов задайте OLLAMA_CONTEXT_LENGTH ≥ 16384" },
  { key: "custom", label: "Свой адрес", base_url: "", catalog_profile: "openai_compatible", requires_key: false, key_hint: "Любой OpenAI-совместимый сервер" },
];

const CATALOG = ["google/gemini-2.5-flash", "openai/gpt-5-mini", "qwen/qwen3-32b", "deepseek/deepseek-chat"];

const now = () => new Date().toISOString();
const delay = <T>(value: T, ms = 150): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(structuredClone(value)), ms));

const state: AiSettings = {
  external_models_enabled: false,
  daily_limit_usd: null,
  operation_limit_usd: null,
  confirm_cost_usd: "1.00",
  confirm_input_tokens: 1_500_000,
  usd_rub_rate: null,
  usd_rub_rate_date: null,
  default_text: null,
  default_speech: null,
  chat_preset: null,
  providers: [],
  roles: [
    { role: "extract", title: "Структура документов", description: "Находит вопросы и сопоставляет ответы.", modality: "text", enabled: true, provider_override_id: null, model_override: null, resolved_provider_id: null, resolved_model: null, model_source: null, required_capabilities: [], parameters: {} },
    { role: "generate", title: "Генерация карточек", description: "Готовит игровые вопросы и варианты ответа.", modality: "text", enabled: true, provider_override_id: null, model_override: null, resolved_provider_id: null, resolved_model: null, model_source: null, required_capabilities: [], parameters: {} },
  ],
  models: [],
  today_usage: { run_count: 0, input_tokens: 0, output_tokens: 0, actual_cost_usd: "0", actual_cost_rub: "0", cache_hits: 0 },
};

function resolveRoles() {
  for (const role of state.roles) {
    const override = role.provider_override_id && role.model_override;
    role.resolved_provider_id = override ? role.provider_override_id : state.default_text?.provider_id ?? null;
    role.resolved_model = override ? role.model_override : state.default_text?.model_id ?? null;
    role.model_source = override ? "role_override" : state.default_text ? "default" : null;
  }
  for (const provider of state.providers) provider.model_count = state.models.filter((m) => m.provider_id === provider.id).length;
}

function provider(id: string): AiProvider {
  const found = state.providers.find((p) => p.id === id);
  if (!found) throw new ApiError(404, "Подключение не найдено", "ai_provider_not_found");
  return found;
}

function addModel(providerId: string, modelId: string, displayName: string) {
  if (state.models.some((m) => m.provider_id === providerId && m.model_id === modelId)) return;
  const model: AiModel = {
    provider_id: providerId, model_id: modelId, display_name: displayName, context_length: 128000, max_completion_tokens: 16000,
    supported_parameters: [], input_modalities: ["text"], output_modalities: ["text"], reasoning: {}, default_parameters: {},
    manual_overrides: {}, prompt_price_usd: null, completion_price_usd: null, knowledge_cutoff: null, expiration_date: null,
    pricing_snapshot_at: now(), catalog_snapshot_at: now(), is_manually_added: false, favorite_order: null, is_available: true,
  };
  state.models.push(model);
  if (!state.default_text) state.default_text = { provider_id: providerId, model_id: modelId };
}

const settings = () => {
  resolveRoles();
  return delay(state);
};

export const mockAi: AiApi = {
  mcpSetup: () => delay({ name: "study-surfers", command: "python", args: ["mcp_server.py"], instructions: "Демо подключения MCP" }),
  installMcp: () => delay({ status: "installed", detail: "В демо-режиме настройки клиента не изменяются." }),
  subscriptions: () => delay([
    { kind: "codex" as const, label: "Подписка ChatGPT", installed: true, status: "ready" as const, detail: "Вход выполнен. Можно подключить подписку.", plan: "plus", provider_id: null, login_can_enter_code: false, login_active: false },
    { kind: "claude" as const, label: "Подписка Claude", installed: true, status: "login_required" as const, detail: "Войдите через официальный Claude Code.", plan: null, provider_id: null, login_can_enter_code: false, login_active: false },
  ]),
  connectSubscription: (kind) => {
    let target = state.providers.find((p) => p.executor_kind === kind);
    if (!target) {
      target = { id: crypto.randomUUID(), label: kind === "codex" ? "Подписка ChatGPT" : "Подписка Claude", executor_kind: kind, catalog_profile: "openai_compatible", base_url: "", has_api_key: false, is_favorite: false, model_count: 0, last_test_status: "connected", last_tested_at: now(), last_catalog_refresh_at: now(), updated_at: now() };
      state.providers.push(target);
    }
    addModel(target.id, kind === "codex" ? "demo-gpt" : "sonnet", kind === "codex" ? "GPT (демо)" : "Claude Sonnet (демо)");
    state.external_models_enabled = true;
    if (!state.default_text) state.default_text = { provider_id: target.id, model_id: kind === "codex" ? "demo-gpt" : "sonnet" };
    return settings();
  },
  loginSubscription: (kind) => delay({ kind, auth_url: null, can_enter_code: false, detail: "В демо-режиме вход не выполняется. Откройте настоящий Study Surfers на порту 8765." }),
  cancelSubscriptionLogin: (kind) => delay({ kind, auth_url: null, can_enter_code: false, detail: "Ожидание отменено." }),
  submitClaudeLoginCode: () => delay({ kind: "claude", auth_url: null, can_enter_code: false, detail: "Демо-режим: авторизация не выполняется." }),
  settings,
  presets: () => delay(PRESETS),
  updateGlobal: (body) => {
    Object.assign(state, body);
    return settings();
  },
  createProvider: (body) => {
    if (state.providers.some((p) => p.label === body.label)) {
      return Promise.reject(new ApiError(409, "Подключение с таким именем уже есть", "ai_provider_label_exists"));
    }
    state.providers.push({
      id: crypto.randomUUID(), label: body.label, executor_kind: "api", catalog_profile: body.catalog_profile ?? "openai_compatible", base_url: body.base_url,
      has_api_key: Boolean(body.api_key), is_favorite: false, model_count: 0, last_test_status: null, last_tested_at: null,
      last_catalog_refresh_at: null, updated_at: now(),
    });
    return settings();
  },
  updateProvider: (id, body) => {
    const target = provider(id);
    Object.assign(target, { label: body.label, base_url: body.base_url, has_api_key: target.has_api_key || Boolean(body.api_key), updated_at: now() });
    return settings();
  },
  deleteProvider: (id) => {
    state.providers = state.providers.filter((p) => p.id !== id);
    state.models = state.models.filter((m) => m.provider_id !== id);
    if (state.default_text?.provider_id === id) state.default_text = null;
    return settings();
  },
  testProvider: (id) => {
    const target = provider(id);
    target.last_test_status = "connected";
    target.last_tested_at = now();
    return delay({ status: "connected" as const, model_count: CATALOG.length, tested_at: now() }, 500);
  },
  searchModels: (providerId) => {
    provider(providerId);
    const added = new Set(state.models.filter((m) => m.provider_id === providerId).map((m) => m.model_id));
    const catalog: AiCatalogModel[] = CATALOG.map((id) => ({
      model_id: id, display_name: id.split("/")[1], context_length: 128000, max_completion_tokens: 16000,
      supported_parameters: ["response_format"], input_modalities: ["text"], output_modalities: ["text"],
      reasoning: {}, default_parameters: {}, prompt_price_usd: "0.0000003", completion_price_usd: "0.0000025",
      knowledge_cutoff: null, expiration_date: null, is_added: added.has(id),
    }));
    return delay(catalog, 600);
  },
  addModel: (providerId, model) => {
    provider(providerId);
    addModel(providerId, model.model_id, model.display_name);
    return settings();
  },
  addManualModel: (providerId, model) => {
    provider(providerId);
    addModel(providerId, model.model_id, model.display_name);
    return settings();
  },
  removeModel: (providerId, modelId) => {
    state.models = state.models.filter((m) => !(m.provider_id === providerId && m.model_id === modelId));
    if (state.default_text?.provider_id === providerId && state.default_text.model_id === modelId) state.default_text = null;
    return settings();
  },
  testModel: (_providerId, modelId) => delay({
    status: "answered" as const, kind: "text" as const, run_id: crypto.randomUUID(), duration_ms: 840, answer: "Готов составлять карточки.",
    actual_model_id: modelId, input_tokens: 24, output_tokens: 6,
  }, 700),
  setDefault: (selection) => {
    state.default_text = selection;
    return settings();
  },
  updateRole: (role, body) => {
    const target = state.roles.find((r) => r.role === role);
    if (!target) return Promise.reject(new ApiError(404, "Функция не найдена", "ai_role_not_found"));
    target.enabled = body.enabled;
    target.provider_override_id = body.provider_override_id ?? null;
    target.model_override = body.model_override ?? null;
    return settings();
  },
};

/** Есть ли в mock-настройках модель для генерации (как ai_model_not_configured у сервера). */
export function mockGeneratorReady(): boolean {
  resolveRoles();
  const role = state.roles.find((r) => r.role === "generate");
  return state.external_models_enabled && Boolean(role?.resolved_model);
}
