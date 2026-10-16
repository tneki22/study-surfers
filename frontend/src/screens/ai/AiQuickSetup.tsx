import { CheckCircle2, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { generatorModel } from "../../api/ai";
import { Button, Dialog, Disclosure, LoadingState } from "../../components/ui";
import { ModelCatalog } from "./ModelCatalog";
import { ProviderForm } from "./ProviderForm";
import { useAiSettings } from "./useAiSettings";
import { SubscriptionsPanel } from "./SubscriptionsPanel";

/**
 * Мини-настройка ИИ прямо из импорта: подключение → модель → «Создать колоду».
 * Открывается, когда сервер ответил ai_model_not_configured; полные настройки —
 * в «Параметрах», здесь только то, без чего карточки не сделать.
 */
export function AiQuickSetup({ open, onOpenChange, onReady }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onReady: () => void;
}) {
  const ai = useAiSettings();
  const { settings, presets, busy, run } = ai;
  const [providerId, setProviderId] = useState<string | null>(null);

  const { reload } = ai;
  useEffect(() => {
    if (open) void reload();
  }, [open, reload]);

  const generator = settings ? generatorModel(settings) : null;
  const provider = settings?.providers.find((p) => p.id === providerId) ?? settings?.providers[0] ?? null;

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Подключим модель для карточек"
      description="Подключите подписку ChatGPT / Claude, API или локальную модель один раз. Дальше файлы превращаются в карточки обычной кнопкой."
      className="ai-quick-setup"
      footer={(
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Позже</Button>
          <Button disabled={!generator} onClick={onReady}>
            <Sparkles size={16} aria-hidden="true" /> Создать колоду
          </Button>
        </>
      )}
    >
      {!settings && <LoadingState label="Загружаю настройки ИИ" />}
      {settings && <SubscriptionsPanel settings={settings} run={run} busy={busy} onConnected={setProviderId} />}
      {settings && generator && (
        <p className="ai-ready-line"><CheckCircle2 size={18} aria-hidden="true" /> Готово: карточки сделает <strong>{generator.model}</strong>.</p>
      )}
      {settings && !provider && (
        <Disclosure summary="Подключить API или локальную модель">
          <ProviderForm
            presets={presets}
            busy={busy === "create"}
            takenLabels={[]}
            onSubmit={(draft) => run("create", async () => {
              const created = await api.ai.createProvider(draft);
              setProviderId(created.providers.find((p) => p.label === draft.label)?.id ?? null);
              return ai.ensureEnabled(created);
            })}
          />
        </Disclosure>
      )}
      {settings && provider && !generator && (
        <>
          <p className="ai-step">Подключение <strong>{provider.label}</strong> есть — выберите модель (звёздочка — модель по умолчанию):</p>
          <ModelCatalog providerId={provider.id} settings={settings} busy={busy} run={async (key, action) => {
            const result = await run(key, action);
            // Модель выбрана, а ИИ на сервере ещё выключен — включаем сразу.
            const fresh = await api.ai.settings();
            if (!fresh.external_models_enabled) await ai.ensureEnabled(fresh);
            else ai.setSettings(fresh);
            return result;
          }} />
        </>
      )}
      {ai.error && <p className="form-error" role="alert">{ai.error}</p>}
    </Dialog>
  );
}
