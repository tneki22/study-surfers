import { ChevronDown, Check, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef } from "react";
import type { RunSummary } from "../../api/types";
import { Button, EmptyState, ErrorState, LoadingState } from "../../components/ui";
import { useRunPages } from "./hooks";
import { accuracy, formatClock, formatDuration, groupRunsByDay, percent } from "./model";
import { RunDetails } from "./RunDetails";

const number = new Intl.NumberFormat("ru-RU");

interface RunRowProps {
  run: RunSummary;
  open: boolean;
  onToggle: (open: boolean) => void;
}

function RunRow({ run, open, onToggle }: RunRowProps) {
  const panelId = useId();
  const row = useRef<HTMLLIElement>(null);

  // Запись, раскрытую из адреса или кнопкой внизу списка, подводим в поле зрения.
  useEffect(() => {
    if (open) row.current?.scrollIntoView({ block: "nearest" });
  }, [open]);

  return (
    <li ref={row} className={`history-run${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="history-run-head"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => onToggle(!open)}
      >
        <span className="history-run-time">{formatClock(run.finished_at)}</span>
        <span className="history-metric history-metric--score">
          <span className="history-metric-label">Очки</span>
          <b>{number.format(run.score)}</b>
        </span>
        <span className="history-metric">
          <span className="history-metric-label">Точность</span>
          <b>{percent(accuracy(run.correct_count, run.wrong_count))}</b>
        </span>
        <span className="history-metric history-metric--right">
          <span className="history-metric-label">Верно</span>
          <b><Check size={13} aria-hidden="true" />{run.correct_count}</b>
        </span>
        <span className="history-metric history-metric--wrong">
          <span className="history-metric-label">Ошибки</span>
          <b><X size={13} aria-hidden="true" />{run.wrong_count}</b>
        </span>
        <span className="history-metric">
          <span className="history-metric-label">Время</span>
          <b>{formatDuration(run.duration_ms)}</b>
        </span>
        <ChevronDown size={18} className="history-run-chevron" aria-hidden="true" />
      </button>
      {open && <RunDetails runId={run.id} panelId={panelId} />}
    </li>
  );
}

interface RunsTabProps {
  deckId: string;
  /** Раскрытый забег из адреса. */
  openId: string | null;
  onOpen: (runId: string | null) => void;
}

export function RunsTab({ deckId, openId, onOpen }: RunsTabProps) {
  const pages = useRunPages(deckId);
  const days = useMemo(() => groupRunsByDay(pages.runs), [pages.runs]);

  // Забег из адреса может лежать глубже первой страницы: дочитываем архив, пока не найдём.
  const { status, runs, hasMore, loadingMore, moreError, loadMore } = pages;
  useEffect(() => {
    if (!openId || status !== "ready" || loadingMore || moreError || !hasMore) return;
    if (!runs.some((run) => run.id === openId)) loadMore();
  }, [openId, status, runs, hasMore, loadingMore, moreError, loadMore]);

  if (status === "loading") return <LoadingState label="Загружаю забеги" />;
  if (status === "error") {
    return (
      <ErrorState title="Не удалось загрузить забеги" message={pages.error ?? ""}>
        <div><Button variant="secondary" onClick={pages.retry}>Повторить</Button></div>
      </ErrorState>
    );
  }
  if (runs.length === 0) {
    return (
      <EmptyState title="Забегов пока нет">
        <p>Сыгранные забеги этой колоды появятся здесь.</p>
      </EmptyState>
    );
  }

  return (
    <div className="history-runs">
      {days.map((day) => (
        <section key={day.key} className="history-day" aria-labelledby={`history-day-${day.key}`}>
          <h3 id={`history-day-${day.key}`}>{day.label}</h3>
          <ul className="history-run-list">
            {day.runs.map((run) => (
              <RunRow key={run.id} run={run} open={run.id === openId} onToggle={(open) => onOpen(open ? run.id : null)} />
            ))}
          </ul>
        </section>
      ))}
      {moreError && (
        <ErrorState title="Не удалось загрузить следующие забеги" message={moreError} />
      )}
      {hasMore && (
        <div className="history-more">
          <Button variant="secondary" disabled={loadingMore} onClick={loadMore}>
            {loadingMore ? "Загружаю…" : moreError ? "Повторить" : "Показать ещё"}
          </Button>
        </div>
      )}
    </div>
  );
}
