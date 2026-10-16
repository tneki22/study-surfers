import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";

interface LoadState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Загрузка данных экрана: результат, ошибка текстом и повтор. Устаревшие ответы отбрасываются. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const run = useCallback(load, deps);

  const reload = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    run().then(
      (value) => {
        if (current !== generation.current) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (current !== generation.current) return;
        setError(reason instanceof Error ? reason.message : String(reason));
        setLoading(false);
      },
    );
  }, [run]);

  useEffect(() => {
    reload();
    return () => {
      generation.current += 1;
    };
  }, [reload]);

  return { data, error, loading, reload };
}

/** Повторяет `tick` каждые `ms`, пока `active`; пауза, пока вкладка скрыта. */
export function usePolling(tick: () => void, ms: number, active: boolean) {
  const saved = useRef(tick);
  saved.current = tick;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") saved.current();
    }, ms);
    return () => clearInterval(timer);
  }, [ms, active]);
}
