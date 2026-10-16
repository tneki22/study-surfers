import { ArrowUpRight, SquareStack } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Link, useLocation } from "react-router";
import { api } from "../api/client";
import type { DeckSummary } from "../api/types";
import { SprayWidget } from "../components/SprayWidget";
import { generationSummary, loadGenerationTasks, type GenerationTask } from "./generationTasks";
import { selectRecentProject, useRecentProject } from "./recentProject";
import { ResumeProject } from "./ResumeProject";

const number = new Intl.NumberFormat("ru-RU");

/** Опрос живёт в шапке, поэтому уход со страницы импорта не прячет генерацию. */
function useGenerationTasks() {
  const [tasks, setTasks] = useState<GenerationTask[]>([]);
  const [decks, setDecks] = useState<DeckSummary[] | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const latest = useRef(tasks);
  const { pathname } = useLocation();

  useEffect(() => {
    let disposed = false;
    let pending = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      if (disposed || pending) return;
      clearTimeout(timer);
      if (document.visibilityState === "visible") {
        pending = true;
        try {
          const nextDecks = await api.listDecks();
          const next = await loadGenerationTasks({ listDecks: async () => nextDecks, listDeckJobs: api.listDeckJobs }, latest.current);
          if (!disposed) {
            latest.current = next;
            setTasks(next);
            setDecks(nextDecks);
            setError(false);
          }
        } catch {
          if (!disposed) {
            setError(true);
            latest.current = latest.current.map((task) => ({ ...task, stale: true }));
            setTasks(latest.current);
          }
        } finally {
          pending = false;
        }
      }
      if (!disposed) timer = setTimeout(refresh, latest.current.length ? 1500 : 5000);
    };
    const onVisible = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    void refresh();
    return () => {
      disposed = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [pathname, revision]);

  return { tasks, decks, error, retry: () => setRevision((value) => value + 1) };
}

function GenerationTaskRow({ task }: { task: GenerationTask }) {
  const { done, total, cards, awaitingConfirm, label, jobId } = generationSummary(task);
  const percent = total > 0 ? Math.min(100, Math.max(0, Math.round(done / total * 100))) : null;
  const status = task.stale ? "Связь с сервером потеряна" : label;
  const attention = awaitingConfirm || task.stale;

  return (
    <Link
      to={`/import/${jobId}?deck=${task.deckId}`}
      className={`generation-task${attention ? " generation-task--attention" : ""}`}
      aria-label={`${task.title}. ${status}. Обработано вопросов ${done} из ${total || "неизвестного количества"}, готовых карточек ${cards}. Открыть подробности`}
      title={`${task.title} · ${status} · Открыть подробности`}
    >
      <span className="generation-task-icon" aria-hidden="true">
        <SprayWidget busy={!attention} />
      </span>
      <span className="generation-task-subject">{task.title}</span>
      <span className="generation-task-track">
        <span className="generation-task-caption">
          <span>{status}</span>
          {percent !== null && <b>{percent}%</b>}
        </span>
        <span
          className={`generation-task-progress${percent === null && !attention ? " is-indeterminate" : ""}`}
          role="progressbar"
          aria-label={`Обработано вопросов: ${task.title}`}
          aria-valuemin={0}
          aria-valuemax={total || undefined}
          aria-valuenow={total > 0 ? Math.min(done, total) : undefined}
          aria-valuetext={total > 0 ? `${done} из ${total}` : status}
          style={{ "--generation-progress": `${percent ?? 0}%` } as CSSProperties}
        >
          <span className="generation-task-fill" />
        </span>
      </span>
      <span className="generation-task-counts" aria-hidden="true">
        <span className="generation-task-count">
          <strong>{number.format(done)}<small> / {total > 0 ? number.format(total) : "—"}</small></strong>
          <span>вопросы</span>
        </span>
        <span className="generation-task-count generation-task-cards" title="Готовых карточек в колоде">
          <strong><SquareStack size={12} />{number.format(cards)}</strong>
          <span>карточки</span>
        </span>
      </span>
      <ArrowUpRight className="generation-task-open" size={14} aria-hidden="true" />
    </Link>
  );
}

export function GenerationStatus() {
  const { tasks, decks, error, retry } = useGenerationTasks();
  const { pathname } = useLocation();
  const deckId = useRecentProject((state) => state.deckId);
  const remember = useRecentProject((state) => state.remember);
  useEffect(() => {
    const opened = /^\/decks\/([^/]+)(?:\/setup)?\/?$/.exec(pathname);
    if (opened) remember(decodeURIComponent(opened[1]));
  }, [pathname, remember]);

  if (!tasks.length) {
    if (pathname !== "/" || (!decks && !error)) return null;
    return <ResumeProject deck={selectRecentProject(decks ?? [], deckId)} error={error} onRetry={retry} />;
  }

  return (
    <div className="generation-status" role="region" aria-label="Фоновые задачи">
      {tasks.map((task) => <GenerationTaskRow key={task.deckId} task={task} />)}
    </div>
  );
}
