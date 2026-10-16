import { AlertTriangle, CheckCircle2, ChevronDown, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { generatorModel, globalWrite } from "../../api/ai";
import type { AiProvider, AiSettings } from "../../api/types";
import { Button, ConfirmDialog, Disclosure, IconButton, LoadingState, Select, StatusBadge, Switch } from "../../components/ui";
import { ModelCatalog } from "./ModelCatalog";
import { ProviderForm } from "./ProviderForm";
import { useAiSettings } from "./useAiSettings";
import { SubscriptionsPanel } from "./SubscriptionsPanel";
import { McpSettings } from "./McpSettings";

const usd = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function ProviderCard({ provider, settings, busy, run, open, onToggle }: {
  provider: AiProvider;
  settings: AiSettings;
  busy: string | null;
  run: ReturnType<typeof useAiSettings>["run"];
  open: boolean;
  onToggle: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const local = /localhost|127\.0\.0\.1/.test(provider.base_url);
  const subscription = provider.executor_kind === "codex" || provider.executor_kind === "claude";
  const tested = provider.last_test_status;
  return (
    <li className={`provider-card ${open ? "is-open" : ""}`.trim()}>
      <div className="provider-head">
        <button type="button" className="provider-title" onClick={onToggle} aria-expanded={open} title={open ? "Свернуть модели" : "Показать модели"}>
          <ChevronDown size={16} className={`item-row-chevron ${open ? "is-open" : ""}`} aria-hidden="true" />
          <span>
            <strong>{provider.label}</strong>
            <small>{subscription ? "Официальный клиент · общий лимит подписки" : provider.base_url}</small>
          </span>
        </button>
        <span className="provider-badges">
          {subscription ? <StatusBadge tone="info">подписка</StatusBadge> : local ? <StatusBadge tone="info">локально</StatusBadge> : !provider.has_api_key && <StatusBadge tone="warning">нет ключа</StatusBadge>}
          {tested === "connected" && <StatusBadge tone="success">на связи</StatusBadge>}
          {tested && tested !== "connected" && <StatusBadge tone="danger">ошибка связи</StatusBadge>}
          <StatusBadge tone="neutral">моделей: {provider.model_count}</StatusBadge>
        </span>
        <Button variant="ghost" disabled={busy === `test-provider:${provider.id}`} onClick={() => run(`test-provider:${provider.id}`, async () => {
          await api.ai.testProvider(provider.id);
          return api.ai.settings();
        })}>
          <RefreshCw size={15} aria-hidden="true" className={busy === `test-provider:${provider.id}` ? "spin" : ""} /> Проверить связь
        </Button>
        <IconButton label={`Удалить подключение ${provider.label}`} onClick={() => setConfirm(true)}><Trash2 size={15} /></IconButton>
      </div>
      {open && <ModelCatalog providerId={provider.id} settings={settings} busy={busy} run={run} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Удалить «${provider.label}»?`}
        confirmLabel="Удалить"
        destructive
        onConfirm={async () => {
          await run(`delete:${provider.id}`, () => api.ai.deleteProvider(provider.id));
        }}
      >
        <p>{subscription ? "Подписка исчезнет из списка моделей Study Surfers. Вход в официальный клиент и сама подписка сохранятся." : "Ключ и добавленные модели этого подключения удалятся."} Готовые колоды останутся.</p>
      </ConfirmDialog>
    </li>
  );
}

/**
 * «Параметры → Искусственный интеллект»: где взять модель для карточек.
 * Сверху — итог одной строкой (какая модель делает карточки), ниже — подключения
 * с моделями, отдельные модели для функций и порог стоимости.
 */
export function AiSection() {
  const ai = useAiSettings();
  const { settings, presets, busy, run } = ai;
  const [openProvider, setOpenProvider] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  if (!settings) {
    return (
      <div className="settings-card">
        {ai.error ? <p className="form-error" role="alert">{ai.error}</p> : <LoadingState label="Загружаю настройки ИИ" />}
      </div>
    );
  }

  const generator = generatorModel(settings);
  const modelOptions = settings.models.filter((model) => model.is_available).map((model) => ({
    value: `${model.provider_id}\n${model.model_id}`,
    label: `${model.display_name} · ${settings.providers.find((p) => p.id === model.provider_id)?.label ?? ""}`,
  }));
  const showForm = adding;

  return (
    <>
      <div className={`settings-card ai-status ${generator ? "is-ready" : "is-missing"}`}>
        {generator ? (
          <p><CheckCircle2 size={18} aria-hidden="true" /> Карточки делает <strong>{generator.model}</strong> через {generator.provider}.</p>
        ) : (
          <p><AlertTriangle size={18} aria-hidden="true" /> Модель для карточек не выбрана — импорт файлов не заработает. Готовые колоды играются и без ИИ.</p>
        )}
        <Switch
          label="Использовать ИИ"
          hint="Разбор файлов и генерация карточек. Выключите, чтобы ни один запрос не ушёл к модели"
          checked={settings.external_models_enabled}
          onCheckedChange={(enabled) => run("global", () => api.ai.updateGlobal(globalWrite(settings, { external_models_enabled: enabled })))}
        />
        {settings.today_usage.run_count ? (
          <small className="ai-usage">
            Сегодня: запросов {settings.today_usage.run_count}, токенов {(settings.today_usage.input_tokens ?? 0) + (settings.today_usage.output_tokens ?? 0)}
            {Number(settings.today_usage.actual_cost_usd) > 0 && `, ${usd.format(Number(settings.today_usage.actual_cost_usd))}`}
          </small>
        ) : null}
      </div>

      <div className="settings-card">
        <SubscriptionsPanel settings={settings} run={run} busy={busy} onConnected={setOpenProvider} />
      </div>

      <div className="settings-card ai-connections">
        <div className="section-head">
          <h3>Подключения и модели</h3>
          <div className="section-head-actions">
            {!showForm && <Button variant="secondary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden="true" /> Добавить API / локальную модель</Button>}
          </div>
        </div>
        {settings.providers.length > 0 && (
          <ul className="provider-list">
            {settings.providers.map((provider) => (
              <ProviderCard
                key={provider.id}
                provider={provider}
                settings={settings}
                busy={busy}
                run={run}
                open={openProvider === provider.id}
                onToggle={() => setOpenProvider(openProvider === provider.id ? null : provider.id)}
              />
            ))}
          </ul>
        )}
        {showForm && (
          <ProviderForm
            presets={presets}
            busy={busy === "create"}
            takenLabels={settings.providers.map((p) => p.label)}
            onSubmit={(draft) => run("create", async () => {
              const created = await api.ai.createProvider(draft);
              const provider = created.providers.find((p) => p.label === draft.label);
              setAdding(false);
              if (provider) setOpenProvider(provider.id);
              return ai.ensureEnabled(created);
            })}
          />
        )}
        {ai.error && <p className="form-error" role="alert">{ai.error}</p>}
      </div>

      <McpSettings run={run} busy={busy} />

      {settings.models.length > 0 && (
        <Disclosure summary="Отдельные модели для функций" className="settings-card">
          {settings.roles.map((role) => {
            const current = role.provider_override_id && role.model_override ? `${role.provider_override_id}\n${role.model_override}` : null;
            return (
              <div key={role.role} className="setting-row">
                <div className="setting-row-text">
                  <span className="setting-row-label">{role.title}</span>
                  <small>{role.description}</small>
                </div>
                <Select
                  ariaLabel={`Модель: ${role.title}`}
                  value={current}
                  emptyOption="Как по умолчанию"
                  options={modelOptions}
                  onValueChange={(value) => {
                    const [provider, model] = value ? value.split("\n") : [null, null];
                    void run(`role:${role.role}`, () => api.ai.updateRole(role.role, { enabled: role.enabled, provider_override_id: provider, model_override: model }));
                  }}
                />
              </div>
            );
          })}
          <label className="setting-row">
            <span className="setting-row-text">
              <span className="setting-row-label">Спрашивать перед дорогой генерацией</span>
              <small>Если оценка стоимости импорта выше порога, сначала покажем её</small>
            </span>
            <span className="setting-row-control cost-input">
              $
              <input
                type="number"
                min={0}
                step={0.5}
                defaultValue={settings.confirm_cost_usd ?? ""}
                onBlur={(event) => {
                  const value = event.target.value.trim();
                  void run("global", () => api.ai.updateGlobal(globalWrite(settings, { confirm_cost_usd: value === "" ? null : value })));
                }}
              />
            </span>
          </label>
        </Disclosure>
      )}

    </>
  );
}
