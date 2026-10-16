import { CheckCircle2, ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api } from "../../api/client";
import type { AiSettings, Subscription, SubscriptionKind, SubscriptionLogin } from "../../api/types";
import { Button, Disclosure, LoadingState, StatusBadge } from "../../components/ui";
import type { useAiSettings } from "./useAiSettings";
import "../../styles/subscriptions.css";

const INSTALL = {
  codex: "https://learn.chatgpt.com/docs/cli",
  claude: "https://code.claude.com/docs/en/setup",
};
const NAMES = { codex: "ChatGPT", claude: "Claude" };

/** Один раз подключаем официальный клиент; дальше используются обычные модели и импорт. */
export function SubscriptionsPanel({ settings, run, busy, onConnected }: {
  settings: AiSettings;
  run: ReturnType<typeof useAiSettings>["run"];
  busy: string | null;
  onConnected?: (providerId: string) => void;
}) {
  const [clients, setClients] = useState<Subscription[] | null>(null);
  const [logins, setLogins] = useState<Partial<Record<SubscriptionKind, SubscriptionLogin>>>({});
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [code, setCode] = useState("");

  const refresh = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setClients(await api.ai.subscriptions());
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const connect = async (kind: SubscriptionKind) => {
    const result = await run(`subscription:${kind}`, () => api.ai.connectSubscription(kind));
    if (result) {
      const provider = result.providers.find((p) => p.executor_kind === kind);
      if (provider) onConnected?.(provider.id);
      setNotice(`Подписка ${NAMES[kind]} подключена. Модели появились ниже — выберите модель по умолчанию звёздочкой. Кнопка «Проверить» подтвердит доступ к ней коротким запросом.`);
      await refresh();
    }
  };

  const login = async (kind: SubscriptionKind) => {
    const result = await run(`login:${kind}`, () => api.ai.loginSubscription(kind));
    if (result) setLogins((current) => ({ ...current, [kind]: result }));
  };

  return (
    <div className="subscription-panel">
      <div className="section-head">
        <h3>Подписки</h3>
        <Button variant="ghost" disabled={checking || !!busy} onClick={refresh}>
          <RefreshCw size={15} className={checking ? "spin" : ""} aria-hidden="true" /> Проверить установку и вход
        </Button>
      </div>
      <p className="screen-hint">Уже оплачиваете ChatGPT или Claude? Подключите подписку один раз и выбирайте её модели в том же списке, что и остальные. Файлы, промпт и кнопка создания колоды работают как обычно.</p>
      {!clients && checking && <LoadingState label="Проверяю официальные клиенты" />}
      {clients && <ul className="subscription-list">
        {clients.map((client) => {
          const connected = settings.providers.some((p) => p.executor_kind === client.kind);
          const pending = logins[client.kind] ?? (client.login_active ? { kind: client.kind, auth_url: client.login_url, detail: "Завершите вход на открытой странице. Если там показан код, вставьте его ниже; затем проверьте вход.", can_enter_code: client.login_can_enter_code } : null);
          const name = NAMES[client.kind];
          return (
            <li key={client.kind} className="subscription-client">
              <div className="subscription-client-head">
                <div><strong>{client.label}</strong><small>{client.kind === "codex" ? "Через официальный Codex" : "Через официальный Claude Code"}{client.plan ? ` · ${client.plan}` : ""}</small></div>
                <StatusBadge tone={client.status === "ready" ? "success" : client.status === "unavailable" ? "danger" : "neutral"}>
                  {client.status === "ready" ? connected ? "подключена" : "вход выполнен" : client.status === "not_installed" ? "нужен клиент" : client.status === "login_required" ? "нужен вход" : "нет связи"}
                </StatusBadge>
              </div>
              <p>{connected && client.status === "ready" ? "Подписка подключена. Выбирайте её модели в общем списке ниже." : client.detail}</p>
              <div className="subscription-actions">
                {client.status === "not_installed" ? (
                  <a className="subscription-link" href={INSTALL[client.kind]} target="_blank" rel="noreferrer">Установить {client.kind === "codex" ? "Codex" : "Claude Code"} <ExternalLink size={14} aria-hidden="true" /></a>
                ) : client.status === "ready" ? (
                  <Button variant={connected ? "secondary" : "primary"} disabled={!!busy || checking} onClick={() => connect(client.kind)}>{busy === `subscription:${client.kind}` ? "Получаю модели…" : connected ? "Обновить модели" : "Подключить подписку"}</Button>
                ) : (
                  <Button variant="secondary" disabled={!!busy || checking} onClick={() => login(client.kind)}>{busy === `login:${client.kind}` ? "Открываю вход…" : `Войти в ${name}`}</Button>
                )}
                {pending && client.status !== "ready" && <Button variant="ghost" disabled={checking || !!busy} onClick={refresh}>Проверить вход</Button>}
              </div>
              {pending && client.status !== "ready" && <div className="subscription-login" role="status">
                <p>{pending.detail}</p>
                {pending.auth_url && <a className="subscription-link" href={pending.auth_url} target="_blank" rel="noreferrer">Открыть вход в {name} <ExternalLink size={14} aria-hidden="true" /></a>}
                {client.kind === "claude" && (pending.can_enter_code || client.login_can_enter_code) && <form className="subscription-code" onSubmit={async (event) => {
                  event.preventDefault();
                  const result = await run("claude-code", () => api.ai.submitClaudeLoginCode(code.trim()));
                  if (result) {
                    setCode("");
                    setLogins((current) => ({ ...current, claude: result }));
                  }
                }}>
                  <label htmlFor="claude-login-code">Одноразовый код из браузера (если появился)</label>
                  <input id="claude-login-code" type="password" autoComplete="off" value={code} onChange={(event) => setCode(event.target.value)} placeholder="Вставьте код со страницы входа" />
                  <Button type="submit" variant="secondary" disabled={!code.trim() || !!busy}>Завершить вход</Button>
                  <small>Код передаётся официальному Claude Code. Study Surfers его не сохраняет.</small>
                </form>}
                <Button variant="ghost" disabled={!!busy} onClick={async () => {
                  const result = await run(`cancel-login:${client.kind}`, () => api.ai.cancelSubscriptionLogin(client.kind));
                  if (result) setLogins((current) => ({ ...current, [client.kind]: undefined }));
                }}>Отменить ожидание входа</Button>
              </div>}
            </li>
          );
        })}
      </ul>}
      {notice && <p className="subscription-notice" role="status"><CheckCircle2 size={17} aria-hidden="true" />{notice}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <Disclosure summary="Как это работает и что нужно установить">
        <p>Для ChatGPT нужен Codex, для Claude — Claude Code. Study Surfers найдёт клиент, включая Codex, поставляемый с приложением Codex, и использует его обычный вход. Вход в ChatGPT или Claude Desktop сам по себе может не подключить этот клиент. Если его нет, ссылка выше откроет официальную инструкцию установки; после установки перезапустите Study Surfers.</p>
        <p>API-ключ не нужен. Разбор материалов, название колоды и карточки выполняются через выбранную подписку. При выборе подписки для карточек прежняя API-модель разбора не используется. Список моделей сообщает официальный клиент; доступ и лимиты зависят от аккаунта. Проверяйте доступ кнопкой «Проверить» у модели.</p>
        <p>Нужен интернет: фрагменты ваших материалов передаются выбранному сервису. Генерация расходует общий лимит подписки; денежную стоимость приложение не рассчитывает. При нехватке лимита готовые карточки сохраняются — позже нажмите «Продолжить». Новую задачу можно запустить с другой выбранной моделью.</p>
      </Disclosure>
    </div>
  );
}
