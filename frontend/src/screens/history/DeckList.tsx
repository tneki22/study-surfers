import { Search, Trophy, X } from "lucide-react";
import { useEffect, useId } from "react";
import { Link } from "react-router";
import type { DeckSummary } from "../../api/types";
import { EmptyState } from "../../components/ui";
import { plural } from "../plural";
import { formatShortDate, historySearch } from "./model";

const number = new Intl.NumberFormat("ru-RU");

/** Идентификатор ссылки на колоду: на узком экране фокус возвращается к ней после «Все колоды». */
export const deckLinkId = (deckId: string): string => `history-deck-${deckId}`;

interface DeckListProps {
  /** Колоды после поиска. */
  decks: DeckSummary[];
  selectedId: string | null;
  query: string;
  onQuery: (query: string) => void;
  /** Куда вернуть фокус при показе списка (узкий экран, возврат из колоды). */
  focusDeckId: string | null;
}

export function DeckList({ decks, selectedId, query, onQuery, focusDeckId }: DeckListProps) {
  const searchId = useId();

  useEffect(() => {
    if (focusDeckId) document.getElementById(deckLinkId(focusDeckId))?.focus({ preventScroll: true });
  }, [focusDeckId]);

  return (
    <aside className="history-panel history-decks" aria-label="Колоды с забегами">
      <div className="history-search">
        <label htmlFor={searchId} className="sr-only">Найти колоду по названию</label>
        <Search size={16} aria-hidden="true" />
        <input
          id={searchId}
          type="search"
          value={query}
          placeholder="Найти колоду"
          autoComplete="off"
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              onQuery("");
            }
          }}
        />
        {query && (
          <button type="button" className="history-search-clear" aria-label="Очистить поиск" onClick={() => onQuery("")}>
            <X size={14} aria-hidden="true" />
          </button>
        )}
      </div>

      {decks.length === 0 ? (
        <EmptyState title="Ничего не найдено" className="history-decks-empty">
          <p>Нет колод с забегами, в названии которых есть «{query.trim()}».</p>
        </EmptyState>
      ) : (
        <ul className="history-deck-list">
          {decks.map((deck) => (
            <li key={deck.id}>
              <Link
                id={deckLinkId(deck.id)}
                to={{ search: historySearch({ deck: deck.id }) }}
                className="history-deck"
                aria-current={deck.id === selectedId ? "true" : undefined}
                title={deck.title}
              >
                <span className="history-deck-title">{deck.title}</span>
                <span className="history-deck-meta">
                  <span>{plural(deck.runs_count, "забег", "забега", "забегов")}</span>
                  {deck.last_played_at && <span>{formatShortDate(deck.last_played_at)}</span>}
                  {deck.best_score !== null && (
                    <span className="history-deck-record" title="Рекорд колоды">
                      <Trophy size={13} aria-hidden="true" />
                      <span className="sr-only">Рекорд </span>
                      {number.format(deck.best_score)}
                    </span>
                  )}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
