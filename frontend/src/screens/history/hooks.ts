import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import { loadItemPages } from "../../api/itemPages";
import type { QuizItem, RunSummary } from "../../api/types";
import { mergeRunPages, RUNS_PAGE_SIZE } from "./model";

const errorText = (reason: unknown): string => (reason instanceof Error ? reason.message : String(reason));

export interface RunPages {
  runs: RunSummary[];
  status: "loading" | "ready" | "error";
  /** Ошибка первой страницы: списка нет, нужен повтор. */
  error: string | null;
  hasMore: boolean;
  loadingMore: boolean;
  /** Ошибка «Показать ещё»: загруженное остаётся на месте. */
  moreError: string | null;
  loadMore: () => void;
  retry: () => void;
}

interface PagesState {
  runs: RunSummary[];
  /** Сколько записей уже прочитано с сервера: следующий `offset`, пока архив не сдвинулся. */
  fetched: number;
  hasMore: boolean;
  status: RunPages["status"];
  error: string | null;
  loadingMore: boolean;
  moreError: string | null;
}

const INITIAL: PagesState = { runs: [], fetched: 0, hasMore: false, status: "loading", error: null, loadingMore: false, moreError: null };

/**
 * Архив забегов выбранной колоды по 20 записей. Состояние живёт ровно столько, сколько
 * колода: при смене `deckId` всё сбрасывается, а ответы на запросы прошлой колоды
 * отбрасываются по номеру поколения.
 */
export function useRunPages(deckId: string): RunPages {
  const [state, setState] = useState<PagesState>(INITIAL);
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const latest = useRef(state);
  latest.current = state;

  useEffect(() => {
    const mine = ++generation.current;
    setState(INITIAL);
    api.listRuns(deckId, { limit: RUNS_PAGE_SIZE, offset: 0 }).then(
      (page) => {
        if (generation.current !== mine) return;
        setState({ ...INITIAL, runs: page, fetched: page.length, hasMore: page.length === RUNS_PAGE_SIZE, status: "ready" });
      },
      (reason: unknown) => {
        if (generation.current !== mine) return;
        setState({ ...INITIAL, status: "error", error: errorText(reason) });
      },
    );
    return () => {
      generation.current += 1;
    };
  }, [deckId, attempt]);

  const loadMore = useCallback(() => {
    const current = latest.current;
    if (current.status !== "ready" || !current.hasMore || current.loadingMore) return;
    const mine = generation.current;
    setState((previous) => ({ ...previous, loadingMore: true, moreError: null }));
    api.listRuns(deckId, { limit: RUNS_PAGE_SIZE, offset: current.fetched }).then(
      (page) => {
        if (generation.current !== mine) return;
        setState((previous) => ({
          ...previous,
          runs: mergeRunPages(previous.runs, page),
          fetched: previous.fetched + page.length,
          hasMore: page.length === RUNS_PAGE_SIZE,
          loadingMore: false,
        }));
      },
      (reason: unknown) => {
        if (generation.current !== mine) return;
        setState((previous) => ({ ...previous, loadingMore: false, moreError: errorText(reason) }));
      },
    );
  }, [deckId]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { runs: state.runs, status: state.status, error: state.error, hasMore: state.hasMore, loadingMore: state.loadingMore, moreError: state.moreError, loadMore, retry };
}

export interface DeckCards {
  items: QuizItem[] | null;
  error: string | null;
  retry: () => void;
}

/** Все активные карточки колоды через обычную постраничную загрузку; остановка при уходе с вкладки. */
export function useDeckCards(deckId: string): DeckCards {
  const [state, setState] = useState<{ items: QuizItem[] | null; error: string | null }>({ items: null, error: null });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState({ items: null, error: null });
    loadItemPages(api.listItems, deckId, {}, () => cancelled).then(
      (page) => {
        if (!cancelled) setState({ items: page.items, error: null });
      },
      (reason: unknown) => {
        if (!cancelled) setState({ items: null, error: errorText(reason) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [deckId, attempt]);

  return { ...state, retry: useCallback(() => setAttempt((value) => value + 1), []) };
}
