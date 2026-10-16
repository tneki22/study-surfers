import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { ApiError } from "../../api/http";
import type { AiSettings, TentexProvider } from "../../api/types";
import { Button, Checkbox, Dialog, LoadingState, StatusBadge } from "../../components/ui";
import { errorText } from "./useAiSettings";

/**
 * Перенос подключений ИИ из Tentex. Ключи расшифровываются ключом Tentex и
 * шифруются нашим; база Tentex только читается. Если Tentex запущен, сервер
 * отвечает tentex_running — предлагаем закрыть его или прочитать как есть.
 */
export function TentexProvidersDialog({ open, onOpenChange, onImported }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (settings: AiSettings) => void;
}) {
  const [providers, setProviders] = useState<TentexProvider[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<{ code: string | null; text: string } | null>(null);
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProviders(null);
    setError(null);
    api.tentex.providers(force).then(
      (list) => {
        setProviders(list);
        setSelected(new Set(list.filter((p) => p.decryptable && !p.already_imported).map((p) => p.tentex_id)));
      },
      (reason) => setError({ code: reason instanceof ApiError ? reason.code : null, text: errorText(reason) }),
    );
  }, [open, force]);

  const importSelected = async () => {
    setBusy(true);
    try {
      const settings = await api.tentex.importProviders({ provider_ids: [...selected], include_models: true, set_default: true }, force);
      onImported(settings);
      onOpenChange(false);
    } catch (reason) {
      setError({ code: reason instanceof ApiError ? reason.code : null, text: errorText(reason) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title="Подключения из Tentex"
      description="Ключи и модели переносятся в Study Surfers; в Tentex ничего не меняется."
      footer={(
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Отмена</Button>
          <Button disabled={busy || !selected.size} onClick={importSelected}>
            <Download size={16} aria-hidden="true" /> {busy ? "Переношу…" : `Перенести (${selected.size})`}
          </Button>
        </>
      )}
    >
      {error && (
        <div className="tentex-error" role="alert">
          <p>{error.text}</p>
          {error.code === "tentex_running" && !force && (
            <Button variant="secondary" onClick={() => setForce(true)}>Всё равно прочитать</Button>
          )}
        </div>
      )}
      {!providers && !error && <LoadingState label="Читаю настройки Tentex" />}
      {providers && providers.length === 0 && <p>В Tentex нет подключений ИИ.</p>}
      {providers && providers.length > 0 && (
        <ul className="tentex-provider-list">
          {providers.map((provider) => (
            <li key={provider.tentex_id}>
              <Checkbox
                checked={selected.has(provider.tentex_id)}
                disabled={!provider.decryptable}
                onCheckedChange={(checked) => setSelected((current) => {
                  const next = new Set(current);
                  if (checked) next.add(provider.tentex_id);
                  else next.delete(provider.tentex_id);
                  return next;
                })}
                label={(
                  <span className="model-name">
                    <strong>{provider.label}</strong>
                    <small>{provider.base_url} · моделей: {provider.model_count}</small>
                  </span>
                )}
              />
              {provider.already_imported && <StatusBadge tone="neutral">уже есть — обновится</StatusBadge>}
              {!provider.decryptable && <StatusBadge tone="warning">ключ не расшифровать</StatusBadge>}
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
