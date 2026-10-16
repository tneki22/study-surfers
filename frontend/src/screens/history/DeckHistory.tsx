import { ArrowLeft, Layers } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import { Link } from "react-router";
import { api } from "../../api/client";
import type { DeckStats, DeckSummary } from "../../api/types";
import { Button, ErrorState, LoadingState, SegmentedTabs } from "../../components/ui";
import { useLoad } from "../../hooks/useLoad";
import { AnalyticsTab } from "./AnalyticsTab";
import { formatMoment, type HistoryTab, type HistoryView } from "./model";
import { RunsTab } from "./RunsTab";

const number = new Intl.NumberFormat("ru-RU");

const TABS: Array<{ value: HistoryTab; label: string }> = [
  { value: "runs", label: "Забеги" },
  { value: "analytics", label: "Аналитика" },
];

function Summary({ stats, deck }: { stats: { data: DeckStats | null; error: string | null; reload: () => void }; deck: DeckSummary }) {
  if (stats.error && !stats.data) {
    return (
      <ErrorState title="Не удалось загрузить сводку" message={stats.error}>
        <div><Button variant="secondary" onClick={stats.reload}>Повторить</Button></div>
      </ErrorState>
    );
  }
  if (!stats.data) return <LoadingState label="Загружаю сводку" />;

  const { data } = stats;
  const last = data.last_run?.finished_at ?? deck.last_played_at;
  // «Освоено» и «слабых» считаются независимо и могут пересекаться — поэтому два отдельных числа, а не доли целого.
  return (
    <dl className="history-summary">
      <div className="history-stat">
        <dt>Забегов</dt>
        <dd>{number.format(data.runs_count)}</dd>
      </div>
      <div className="history-stat">
        <dt>Рекорд</dt>
        <dd>{data.best_score === null ? "—" : number.format(data.best_score)}</dd>
      </div>
      <div className="history-stat">
        <dt>Встречалось карточек</dt>
        <dd>{number.format(data.seen_count)}<span> из {number.format(data.item_count)}</span></dd>
        <small>Из активных карточек колоды</small>
      </div>
      <div className="history-stat">
        <dt>Освоено</dt>
        <dd>{number.format(data.mastered_count)}</dd>
        <small>Два верных ответа подряд</small>
      </div>
      <div className="history-stat">
        <dt>Слабых</dt>
        <dd>{number.format(data.weak_count)}</dd>
        <small>Ошибки без двух верных подряд или точность ниже 60 %</small>
      </div>
      <div className="history-stat">
        <dt>Последний забег</dt>
        <dd className="history-stat-date">{last ? formatMoment(last) : "—"}</dd>
      </div>
    </dl>
  );
}

interface DeckHistoryProps {
  deck: DeckSummary;
  view: HistoryView;
  onChange: (next: Partial<HistoryView>) => void;
  /** Узкий экран: колода занимает всё место, сверху — возврат к списку. */
  showBack: boolean;
  /** После перехода из списка перевести фокус на название колоды. */
  focusOnMount: boolean;
}

/** Содержимое выбранной колоды. Ставится с `key={deck.id}`: смена колоды стирает всё прежнее состояние. */
export function DeckHistory({ deck, view, onChange, showBack, focusOnMount }: DeckHistoryProps) {
  const stats = useLoad(() => api.getDeckStats(deck.id), [deck.id]);
  const titleId = useId();
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (focusOnMount) heading.current?.focus({ preventScroll: true });
  }, [focusOnMount]);

  return (
    <section className="history-deck-view" aria-labelledby={titleId}>
      {showBack && (
        <Link to={{ search: "" }} className="history-back">
          <ArrowLeft size={16} aria-hidden="true" /> Все колоды
        </Link>
      )}

      <header className="history-panel history-deck-head">
        <h2 id={titleId} ref={heading} tabIndex={-1}>{deck.title}</h2>
        <Link to={`/decks/${deck.id}`} className="secondary-button history-cards-link">
          <Layers size={16} aria-hidden="true" /> Карточки колоды
        </Link>
      </header>

      <div className="history-panel history-summary-panel">
        <Summary stats={stats} deck={deck} />
      </div>

      <div className="history-panel history-content">
        <SegmentedTabs<HistoryTab>
          label="Раздел истории"
          className="history-tabs"
          value={view.tab}
          tabs={TABS}
          onChange={(tab) => onChange({ deck: deck.id, tab })}
        />
        <div className="history-tabpanel" role="tabpanel" aria-label={view.tab === "runs" ? "Забеги" : "Аналитика"}>
          {view.tab === "runs" ? (
            <RunsTab deckId={deck.id} openId={view.run} onOpen={(run) => onChange({ deck: deck.id, tab: "runs", run })} />
          ) : (
            <AnalyticsTab deckId={deck.id} stats={stats} />
          )}
        </div>
      </div>
    </section>
  );
}
