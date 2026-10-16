import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { Disclosure, LoadingState, StatusBadge } from "../../components/ui";
import type { SessionSettings } from "../../game/engine/settings";
import { useLoad } from "../../hooks/useLoad";
import { MarkdownInline } from "../../markdown/MarkdownView";
import { plural } from "../plural";

const PAGE_SIZE = 10;

/**
 * Какие карточки попадут в забег при текущих настройках: фильтр «Какие» и
 * переключатель «ответ ИИ» применяются сразу. Список раскрывается внизу экрана,
 * на всю ширину, по 10 карточек за раз.
 */
export function RunCards({ deckId, settings }: { deckId: string; settings: SessionSettings }) {
  const page = useLoad(() => api.listItems(deckId, { filter: settings.filter }), [deckId, settings.filter]);
  const [shown, setShown] = useState(PAGE_SIZE);
  const items = (page.data?.items ?? [])
    .filter((item) => settings.includeAiItems || item.source !== "ai_knowledge")
    .sort((a, b) => a.seq - b.seq);
  useEffect(() => setShown(PAGE_SIZE), [settings.filter, settings.includeAiItems]);
  const limit = settings.count === "all" ? items.length : Math.min(settings.count, items.length);
  const summary = page.data ? `Карточки забега (${items.length})` : "Карточки забега";
  const rest = items.length - shown;

  return (
    <Disclosure summary={summary} className="run-cards">
      {page.loading && !page.data && <LoadingState label="Загружаю карточки" />}
      {page.error && <p className="form-error" role="alert">{page.error}</p>}
      {page.data && (
        <>
          <div className="run-cards-bar">
            <p className="run-cards-note">
              {items.length === 0
                ? "Под эти настройки не подходит ни одна карточка."
                : limit < items.length
                  ? `В забег попадут ${plural(limit, "карточка", "карточки", "карточек")} из ${items.length}${settings.order === "shuffle" ? ", вперемешку" : ", по порядку программы"}.`
                  : settings.order === "shuffle" ? "Все карточки, вперемешку." : "Все карточки, по порядку программы."}
            </p>
          </div>
          <ol className="run-cards-list">
            {items.slice(0, shown).map((item) => (
              <li key={item.id}>
                <span className="run-cards-prompt"><MarkdownInline text={item.prompt} /></span>
                <span className="run-cards-answer"><MarkdownInline text={item.correct} /></span>
                {item.source === "ai_knowledge" && <StatusBadge tone="info">ответ ИИ</StatusBadge>}
              </li>
            ))}
            {rest > 0 && (
              <li className="run-cards-more">
                <button type="button" className="link-button" onClick={() => setShown((count) => count + PAGE_SIZE)}>
                  Показать ещё {Math.min(PAGE_SIZE, rest)} (осталось {rest})
                </button>
              </li>
            )}
          </ol>
        </>
      )}
    </Disclosure>
  );
}
