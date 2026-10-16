/* Транспорт API (из Tentex): единая точка fetch, разбора ошибок и повторов при старте сервера.
   Ошибка бэкенда всегда {detail, code, context} — см. contract/README.md. */

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string | null = null,
    public readonly context: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function errorPayload(payload: unknown, status: number): {
  message: string;
  code: string | null;
  context: Record<string, unknown>;
} {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : null;
    const context = record.context && typeof record.context === "object"
      ? record.context as Record<string, unknown>
      : {};
    if (typeof record.detail === "string") return { message: record.detail, code, context };
    if (Array.isArray(record.detail)) {
      const message = record.detail
        .map((item) => item && typeof item === "object" && "msg" in item ? String(item.msg) : "")
        .filter(Boolean)
        .join(". ");
      if (message) return { message, code, context };
    }
  }
  return { message: `Запрос завершился с ошибкой ${status}`, code: null, context: {} };
}

/* При старте стека Vite-прокси уже слушает порт, а API ещё поднимается: прокси
   отвечает 502 без тела. Это не ошибка приложения, а «подождите», поэтому
   безопасные GET повторяются, пока экран показывает загрузку. Ошибки AI-шлюза
   тоже бывают 502–504, но приходят с JSON и кодом — их не повторяем. */
const API_STARTING_STATUSES = new Set([502, 503, 504]);
const API_STARTING_RETRY_DELAYS_MS = [400, 800, 1600, 3200, 5000];

function pause(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Единая точка fetch к API: JSON-заголовки, разбор ошибок в `ApiError`, повтор GET при старте стека. */
export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  // FormData сам проставляет multipart-границу: свой Content-Type её ломает.
  if (typeof init.body === "string") headers.set("Content-Type", "application/json");
  const isRead = (init.method ?? "GET").toUpperCase() === "GET";
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(path, { ...init, headers });
    const payload: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (response.ok) return payload as T;
    const retryDelay = API_STARTING_RETRY_DELAYS_MS[attempt];
    if (isRead && payload === null && API_STARTING_STATUSES.has(response.status) && retryDelay !== undefined) {
      await pause(retryDelay, init.signal);
      continue;
    }
    const error = errorPayload(payload, response.status);
    throw new ApiError(response.status, error.message, error.code, error.context);
  }
}
