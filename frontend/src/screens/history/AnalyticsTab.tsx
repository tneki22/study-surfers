import { ChevronDown, RotateCcw, Target } from "lucide-react";
import { useId, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import type { DeckStats } from "../../api/types";
import { Button, EmptyState, ErrorState, LoadingState, StatusBadge } from "../../components/ui";
import { useLoad } from "../../hooks/useLoad";
import { MarkdownInline, MarkdownView } from "../../markdown/MarkdownView";
import { plural } from "../plural";
import { useDeckCards } from "./hooks";
import {
  FREQUENT_PREVIEW,
  formatMoment,
  frequentMistakes,
  itemAccuracy,
  percent,
  topicRows,
  type FrequentMistake,
} from "./model";

/** Запуск повторения: ссылка на настройку забега с предвыбранным фильтром, а когда повторять нечего — неактивная кнопка с причиной. */
function RepeatAction({ to, enabled, children, reason }: { to: string; enabled: boolean; children: ReactNode; reason?: string }) {
  const hintId = useId();
  return (
    <div className="history-action">
      {enabled ? (
        <Link to={to} className="secondary-button history-action-button">{children}</Link>
      ) : (
        <Button variant="secondary" className="history-action-button" disabled aria-describedby={reason ? hintId : undefined}>{children}</Button>
      )}
      {reason && <small id={hintId}>{reason}</small>}
    </div>
  );
}

function MistakeCard({ mistake }: { mistake: FrequentMistake }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const { item } = mistake;
  const lastWrong = item.stats?.last_wrong_at ?? null;

  return (
    <li className={`history-hard${open ? " is-open" : ""}`}>
      <button type="button" className="history-hard-head" aria-expanded={open} aria-controls={open ? panelId : undefined} onClick={() => setOpen(!open)}>
        <span className="history-hard-prompt"><MarkdownInline text={item.prompt} /></span>
        <span className="history-hard-facts">
          <span className="history-hard-errors">
            {plural(mistake.errors, "ошибка", "ошибки", "ошибок")} за {plural(mistake.seen, "показ", "показа", "показов")}
          </span>
          <span>точность {percent(itemAccuracy(mistake))}</span>
          <span>серия верных: {item.stats?.streak ?? 0}</span>
          <span>{lastWrong ? `последняя ошибка: ${formatMoment(lastWrong)}` : "дата ошибки неизвестна"}</span>
        </span>
        <ChevronDown size={18} className="history-run-chevron" aria-hidden="true" />
      </button>
      {open && (
        <div className="history-hard-body" id={panelId}>
          <div className="history-answer is-right">
            <h4>Верный ответ {item.source === "ai_knowledge" && <StatusBadge tone="info">ответ ИИ</StatusBadge>}</h4>
            <div><MarkdownInline text={item.correct} /></div>
          </div>
          {item.explanation && (
            <div className="history-answer">
              <h4>Объяснение</h4>
              <MarkdownView text={item.explanation} />
            </div>
          )}
        </div>
      )}
    </li>
  );
}

function FrequentMistakes({ deckId }: { deckId: string }) {
  const cards = useDeckCards(deckId);
  const [showAll, setShowAll] = useState(false);
  const rows = useMemo(() => (cards.items ? frequentMistakes(cards.items) : []), [cards.items]);
  const visible = showAll ? rows : rows.slice(0, FREQUENT_PREVIEW);

  return (
    <section className="history-block" aria-labelledby="history-hard-title">
      <h3 id="history-hard-title">Частые ошибки</h3>
      {cards.error && (
        <ErrorState title="Не удалось загрузить карточки" message={cards.error}>
          <div><Button variant="secondary" onClick={cards.retry}>Повторить</Button></div>
        </ErrorState>
      )}
      {!cards.items && !cards.error && <LoadingState label="Считаю ошибки" />}
      {cards.items && rows.length === 0 && (
        <EmptyState title="Ошибок пока нет">
          <p>Среди активных карточек нет ни одной, на которую ответили неверно.</p>
        </EmptyState>
      )}
      {rows.length > 0 && (
        <>
          <ol className="history-hard-list">
            {visible.map((mistake) => <MistakeCard key={mistake.item.id} mistake={mistake} />)}
          </ol>
          {rows.length > FREQUENT_PREVIEW && (
            <div className="history-more">
              <Button variant="secondary" aria-expanded={showAll} onClick={() => setShowAll(!showAll)}>
                {showAll ? "Свернуть" : `Показать остальные (${rows.length - FREQUENT_PREVIEW})`}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Topics({ stats }: { stats: DeckStats }) {
  const rows = useMemo(() => topicRows(stats.by_section), [stats.by_section]);
  return (
    <section className="history-block" aria-labelledby="history-topics-title">
      <h3 id="history-topics-title">Точность по темам</h3>
      {rows.length === 0 ? (
        <p className="history-note">Тем с ответами пока нет.</p>
      ) : (
        <ul className="history-topics">
          {rows.map((row) => (
            <li key={row.key}>
              <span className="history-topic-name" title={row.label}>{row.label}</span>
              <span className="history-topic-count">карточек с ответами: {row.count}</span>
              <span
                className={`history-topic-bar${row.accuracy < 0.6 ? " is-low" : row.accuracy >= 0.85 ? " is-high" : ""}`}
                style={{ "--value": `${Math.round(row.accuracy * 100)}%` } as CSSProperties}
                aria-hidden="true"
              />
              <b className="history-topic-value">{percent(row.accuracy)}</b>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface AnalyticsTabProps {
  deckId: string;
  stats: { data: DeckStats | null; error: string | null; reload: () => void };
}

export function AnalyticsTab({ deckId, stats }: AnalyticsTabProps) {
  // «Ошибки последнего забега» предлагаем, только если в нём остались доступные активные карточки.
  const lastMistakes = useLoad(() => api.listItems(deckId, { filter: "last_mistakes", limit: 1 }), [deckId]);
  const weakCount = stats.data?.weak_count ?? 0;
  const canRepeatLast = (lastMistakes.data?.total_ready ?? 0) > 0;

  return (
    <div className="history-analytics">
      <div className="history-actions" role="group" aria-label="Повторение">
        <RepeatAction
          to={`/decks/${deckId}/setup?filter=weak`}
          enabled={weakCount > 0}
          reason={!stats.data ? (stats.error ? "Не удалось узнать, есть ли слабые карточки" : "Проверяю слабые карточки…") : weakCount === 0 ? "Слабых карточек пока нет" : undefined}
        >
          <Target size={16} aria-hidden="true" /> Повторить слабые
        </RepeatAction>
        <RepeatAction
          to={`/decks/${deckId}/setup?filter=last_mistakes`}
          enabled={canRepeatLast}
          reason={lastMistakes.error
            ? "Не удалось проверить последний забег"
            : !lastMistakes.data
              ? "Проверяю последний забег…"
              : canRepeatLast ? undefined : "В последнем забеге нет ошибок среди активных карточек"}
        >
          <RotateCcw size={16} aria-hidden="true" /> Ошибки последнего забега
        </RepeatAction>
        {(lastMistakes.error || stats.error) && (
          <Button variant="ghost" onClick={() => { lastMistakes.reload(); stats.reload(); }}>Повторить проверку</Button>
        )}
      </div>

      <FrequentMistakes deckId={deckId} />

      {stats.data ? (
        <Topics stats={stats.data} />
      ) : (
        <section className="history-block" aria-labelledby="history-topics-title">
          <h3 id="history-topics-title">Точность по темам</h3>
          {stats.error ? (
            <ErrorState title="Не удалось загрузить темы" message={stats.error}>
              <div><Button variant="secondary" onClick={stats.reload}>Повторить</Button></div>
            </ErrorState>
          ) : (
            <LoadingState label="Загружаю темы" />
          )}
        </section>
      )}
    </div>
  );
}
