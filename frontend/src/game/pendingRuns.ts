import type { RunIn } from "../api/types";

const KEY = "ss:pendingRuns";
type QueueStorage = Pick<Storage, "getItem" | "setItem">;

/** Запись до отправки переживает закрытие окна; подтверждение удаляет только свой id. */
export function createRunLog(send: (run: RunIn) => Promise<unknown>, storage: () => QueueStorage) {
  const inFlight = new Map<string, Promise<boolean>>();

  function read(): RunIn[] {
    try {
      const value: unknown = JSON.parse(storage().getItem(KEY) ?? "[]");
      return Array.isArray(value) ? value.filter((run): run is RunIn =>
        run !== null && typeof run === "object" && typeof run.id === "string" && typeof run.deck_id === "string") : [];
    } catch { return []; }
  }

  function write(runs: RunIn[]) {
    try { storage().setItem(KEY, JSON.stringify(runs.slice(-50))); }
    catch { /* Хранилище недоступно; отправка на сервер всё равно возможна. */ }
  }

  function deliver(run: RunIn): Promise<boolean> {
    const current = inFlight.get(run.id);
    if (current) return current;
    const operation = (async () => {
      try {
        await Promise.resolve().then(() => send(run));
        write(read().filter((entry) => entry.id !== run.id));
        return true;
      } catch { return false; }
      finally { inFlight.delete(run.id); }
    })();
    inFlight.set(run.id, operation);
    return operation;
  }

  return {
    async submitRun(run: RunIn): Promise<"saved" | "offline"> {
      write([...read().filter((entry) => entry.id !== run.id), run]);
      return await deliver(run) ? "saved" : "offline";
    },
    async flushPendingRuns(): Promise<void> {
      for (const run of read()) await deliver(run);
    },
  };
}
