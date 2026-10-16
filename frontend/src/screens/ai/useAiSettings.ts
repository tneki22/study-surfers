import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import { globalWrite } from "../../api/ai";
import { ApiError } from "../../api/http";
import type { AiPreset, AiSettings } from "../../api/types";

export function errorText(reason: unknown): string {
  if (reason instanceof ApiError) return reason.message;
  return reason instanceof Error ? reason.message : String(reason);
}

/**
 * Настройки ИИ экрана: загрузка, пресеты и обёртка действий. Каждое действие
 * сервера возвращает свежие настройки целиком — их и показываем; ошибка
 * действия попадает в `error` текстом сервера.
 */
export function useAiSettings() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [presets, setPresets] = useState<AiPreset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const [next, list] = await Promise.all([api.ai.settings(), api.ai.presets()]);
      setSettings(next);
      setPresets(list);
      setError(null);
    } catch (reason) {
      setError(errorText(reason));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  /** Выполнить действие под меткой `key` (для «крутилки» на нужной кнопке). */
  const run = useCallback(async <T,>(key: string, action: () => Promise<T>): Promise<T | null> => {
    setBusy(key);
    setError(null);
    try {
      const result = await action();
      if (result && typeof result === "object" && "providers" in result && "roles" in result) setSettings(result as unknown as AiSettings);
      return result;
    } catch (reason) {
      setError(errorText(reason));
      return null;
    } finally {
      setBusy(null);
    }
  }, []);

  /** ИИ на сервере выключен по умолчанию — включаем, как только пользователь подключает модель. */
  const ensureEnabled = useCallback(async (current: AiSettings) => {
    if (current.external_models_enabled) return current;
    const next = await api.ai.updateGlobal(globalWrite(current, { external_models_enabled: true }));
    setSettings(next);
    return next;
  }, []);

  return { settings, setSettings, presets, error, setError, busy, run, reload, ensureEnabled };
}
