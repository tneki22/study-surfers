import { Plug } from "lucide-react";
import { useState } from "react";
import type { AiPreset, AiProviderWrite } from "../../api/types";
import { Button, Field, SegmentedTabs } from "../../components/ui";

export type ProviderDraft = Required<AiProviderWrite>;

/**
 * Новое подключение: пресет подставляет адрес и подсказку про ключ; для LM Studio
 * и Ollama ключ не нужен. Отправка — наружу, форма только собирает поля.
 */
export function ProviderForm({ presets, busy, takenLabels, onSubmit }: {
  presets: AiPreset[];
  busy: boolean;
  takenLabels: string[];
  onSubmit: (draft: ProviderDraft) => void;
}) {
  const [presetKey, setPresetKey] = useState(presets[0]?.key ?? "openrouter");
  const preset = presets.find((p) => p.key === presetKey) ?? presets[0];
  const [label, setLabel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [key, setKey] = useState("");

  if (!preset) return null;
  const custom = preset.key === "custom";
  const finalLabel = (label.trim() || preset.label).trim();
  const finalUrl = (baseUrl.trim() || preset.base_url).trim();
  const labelTaken = takenLabels.includes(finalLabel);
  const missingKey = preset.requires_key && !key.trim();

  return (
    <form
      className="provider-form"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit({
          label: finalLabel,
          base_url: finalUrl,
          catalog_profile: preset.catalog_profile === "openrouter" ? "openrouter" : "openai_compatible",
          api_key: key.trim() || null,
        });
      }}
    >
      <SegmentedTabs
        label="Где модель"
        value={presetKey}
        tabs={presets.map((p) => ({ value: p.key, label: p.label }))}
        onChange={(value) => {
          setPresetKey(value);
          setBaseUrl("");
        }}
      />
      <div className="provider-form-grid">
        <Field label="Название" hint="Как подключение будет подписано в списках" error={labelTaken ? "Такое название уже есть" : undefined}>
          <input value={label} placeholder={preset.label} onChange={(event) => setLabel(event.target.value)} />
        </Field>
        <Field label="Адрес API" hint={custom ? "OpenAI-совместимый, обычно оканчивается на /v1" : "Подставлен из пресета"} required={custom}>
          <input value={baseUrl} placeholder={preset.base_url || "http://localhost:8080/v1"} onChange={(event) => setBaseUrl(event.target.value)} />
        </Field>
        <Field label={preset.requires_key ? "Ключ API" : "Ключ API (не обязателен)"} hint={preset.key_hint} required={preset.requires_key}>
          <input type="password" autoComplete="off" value={key} onChange={(event) => setKey(event.target.value)} />
        </Field>
      </div>
      <Button type="submit" disabled={busy || labelTaken || missingKey || !finalUrl}>
        <Plug size={16} aria-hidden="true" /> {busy ? "Подключаю…" : "Подключить"}
      </Button>
    </form>
  );
}
