import { request } from "./http";
import type {
  AiCatalogModel,
  AiCatalogModelWrite,
  AiGlobalSettingsWrite,
  AiManualModelWrite,
  AiModelSelection,
  AiModelTest,
  AiPreset,
  AiProviderTest,
  AiProviderWrite,
  AiRoleWrite,
  AiSettings,
  TentexImportResult,
  TentexProject,
  TentexProjectImport,
  TentexProvider,
  TentexProvidersImport,
  TentexStatus,
  Subscription,
  SubscriptionKind,
  SubscriptionLogin,
  McpSetup,
  McpInstall,
} from "./types";

/** Настройки ИИ: подключения, модели, модель по умолчанию и функции (роли). Форма — как в Tentex. */
export interface AiApi {
  mcpSetup(): Promise<McpSetup>;
  installMcp(client: SubscriptionKind): Promise<McpInstall>;
  subscriptions(): Promise<Subscription[]>;
  connectSubscription(kind: SubscriptionKind): Promise<AiSettings>;
  loginSubscription(kind: SubscriptionKind): Promise<SubscriptionLogin>;
  cancelSubscriptionLogin(kind: SubscriptionKind): Promise<SubscriptionLogin>;
  submitClaudeLoginCode(code: string): Promise<SubscriptionLogin>;
  settings(): Promise<AiSettings>;
  presets(): Promise<AiPreset[]>;
  updateGlobal(body: AiGlobalSettingsWrite): Promise<AiSettings>;
  createProvider(body: AiProviderWrite): Promise<AiSettings>;
  updateProvider(id: string, body: AiProviderWrite): Promise<AiSettings>;
  deleteProvider(id: string): Promise<AiSettings>;
  testProvider(id: string): Promise<AiProviderTest>;
  searchModels(providerId: string): Promise<AiCatalogModel[]>;
  addModel(providerId: string, model: AiCatalogModelWrite): Promise<AiSettings>;
  addManualModel(providerId: string, model: AiManualModelWrite): Promise<AiSettings>;
  removeModel(providerId: string, modelId: string): Promise<AiSettings>;
  testModel(providerId: string, modelId: string): Promise<AiModelTest>;
  setDefault(selection: AiModelSelection | null): Promise<AiSettings>;
  updateRole(role: string, body: AiRoleWrite): Promise<AiSettings>;
}

/** Только чтение соседнего Tentex: статус, проекты и подключения ИИ для переноса. */
export interface TentexApi {
  status(): Promise<TentexStatus>;
  projects(force?: boolean): Promise<TentexProject[]>;
  importProject(id: string, body: TentexProjectImport, force?: boolean): Promise<TentexImportResult>;
  providers(force?: boolean): Promise<TentexProvider[]>;
  importProviders(body: TentexProvidersImport, force?: boolean): Promise<AiSettings>;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const base = "/api/settings/ai";
const forceQuery = (force?: boolean) => (force ? "?force=true" : "");

export const realAi: AiApi = {
  mcpSetup: () => request(`${base}/mcp`),
  installMcp: (client) => request(`${base}/mcp/install/${client}`, { method: "POST" }),
  subscriptions: () => request(`${base}/subscriptions`),
  connectSubscription: (kind) => request(`${base}/subscriptions/${kind}/connect`, { method: "POST" }),
  loginSubscription: (kind) => request(`${base}/subscriptions/${kind}/login`, { method: "POST" }),
  cancelSubscriptionLogin: (kind) => request(`${base}/subscriptions/${kind}/login/cancel`, { method: "POST" }),
  submitClaudeLoginCode: (code) => request(`${base}/subscriptions/claude/login/code`, json("POST", { code })),
  settings: () => request(base),
  presets: () => request(`${base}/presets`),
  updateGlobal: (body) => request(base, json("PUT", body)),
  createProvider: (body) => request(`${base}/providers`, json("POST", body)),
  updateProvider: (id, body) => request(`${base}/providers/${id}`, json("PUT", body)),
  deleteProvider: (id) => request(`${base}/providers/${id}`, { method: "DELETE" }),
  testProvider: (id) => request(`${base}/providers/${id}/test`, { method: "POST" }),
  searchModels: (providerId) => request(`${base}/providers/${providerId}/models/search`, { method: "POST" }),
  addModel: (providerId, model) => request(`${base}/providers/${providerId}/models`, json("POST", model)),
  addManualModel: (providerId, model) => request(`${base}/providers/${providerId}/models/manual`, json("PUT", model)),
  removeModel: (providerId, modelId) =>
    request(`${base}/providers/${providerId}/models?model_id=${encodeURIComponent(modelId)}`, { method: "DELETE" }),
  testModel: (providerId, modelId) => request(`${base}/providers/${providerId}/models/test`, json("POST", { model_id: modelId })),
  setDefault: (selection) => request(`${base}/defaults/text`, json("PUT", { selection })),
  updateRole: (role, body) => request(`${base}/roles/${role}`, json("PUT", body)),
};

export const realTentex: TentexApi = {
  status: () => request("/api/tentex/status"),
  projects: (force) => request(`/api/tentex/projects${forceQuery(force)}`),
  importProject: (id, body, force) => request(`/api/tentex/projects/${id}/import${forceQuery(force)}`, json("POST", body)),
  providers: (force) => request(`/api/tentex/providers${forceQuery(force)}`),
  importProviders: (body, force) => request(`/api/tentex/providers/import${forceQuery(force)}`, json("POST", body)),
};

/** Текущие глобальные настройки в форме PUT: остальные поля не сбрасываются. */
export function globalWrite(settings: AiSettings, patch: Partial<AiGlobalSettingsWrite> = {}): AiGlobalSettingsWrite {
  return {
    external_models_enabled: settings.external_models_enabled,
    daily_limit_usd: settings.daily_limit_usd,
    operation_limit_usd: settings.operation_limit_usd,
    confirm_cost_usd: settings.confirm_cost_usd,
    confirm_input_tokens: settings.confirm_input_tokens,
    usd_rub_rate: settings.usd_rub_rate,
    usd_rub_rate_date: settings.usd_rub_rate_date,
    ...patch,
  };
}

/** Какая модель на деле будет делать карточки (роль generate), или null. */
export function generatorModel(settings: AiSettings): { provider: string; model: string } | null {
  const role = settings.roles.find((r) => r.role === "generate");
  if (!settings.external_models_enabled || !role?.enabled || !role.resolved_provider_id || !role.resolved_model) return null;
  const provider = settings.providers.find((p) => p.id === role.resolved_provider_id);
  const model = settings.models.find((m) => m.provider_id === role.resolved_provider_id && m.model_id === role.resolved_model && m.is_available);
  return provider && model ? { provider: provider.label, model: model.display_name } : null;
}
