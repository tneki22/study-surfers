import { History as HistoryIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { api } from "../../api/client";
import { Button, EmptyState, ErrorState, LoadingState } from "../../components/ui";
import { useLoad } from "../../hooks/useLoad";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { DeckHistory } from "./DeckHistory";
import { DeckList } from "./DeckList";
import {
  WIDE_QUERY,
  decksWithRuns,
  filterDecks,
  historySearch,
  readHistoryView,
  resolveSelectedDeck,
  type HistoryView,
} from "./model";

/**
 * «История»: колоды с забегами слева, выбранная колода справа. Колода, вкладка и раскрытый
 * забег лежат в адресе, поэтому работают перезагрузка и кнопки «назад/вперёд».
 */
export function HistoryScreen() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const wide = useMediaQuery(WIDE_QUERY);
  const decks = useLoad(() => api.listDecks(), []);
  const [query, setQuery] = useState("");

  const view = readHistoryView(params);
  const withRuns = useMemo(() => (decks.data ? decksWithRuns(decks.data) : []), [decks.data]);
  const shown = useMemo(() => filterDecks(withRuns, query), [withRuns, query]);
  const selected = resolveSelectedDeck(withRuns, view.deck, wide);

  const change = useCallback((next: Partial<HistoryView>) => navigate({ search: historySearch(next) }), [navigate]);

  // Фокус и прокрутка ведутся только после перехода внутри экрана: перезагрузка страницы их не трогает.
  const location = useLocation();
  const entryKey = useRef(location.key);
  const guided = !wide && location.key !== entryKey.current;
  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    if (selected) lastSelected.current = selected.id;
  }, [selected]);
  useEffect(() => {
    if (guided) window.scrollTo(0, 0);
  }, [selected?.id, guided]);

  return (
    <div className="history">
      <header className="history-head">
        <h1 className="history-sticker">
          <HistoryIcon size={22} aria-hidden="true" />
          <span>История</span>
        </h1>
      </header>

      {decks.loading && !decks.data && <div className="history-panel"><LoadingState label="Загружаю историю" /></div>}
      {decks.error && !decks.data && (
        <div className="history-panel">
          <ErrorState message={decks.error} title="Сервер не отвечает">
            <div><Button variant="secondary" onClick={decks.reload}>Повторить</Button></div>
          </ErrorState>
        </div>
      )}
      {decks.data && withRuns.length === 0 && (
        <div className="history-panel">
          <EmptyState title="История пока пуста">
            <p>Здесь появятся забеги по колодам: результаты, разбор ошибок и аналитика.</p>
            <Link to="/" className="secondary-button">К колодам</Link>
          </EmptyState>
        </div>
      )}
      {decks.data && withRuns.length > 0 && (
        <div className="history-layout">
          {(wide || !selected) && (
            <DeckList
              decks={shown}
              selectedId={selected?.id ?? null}
              query={query}
              onQuery={setQuery}
              focusDeckId={guided ? lastSelected.current : null}
            />
          )}
          {selected && (
            <DeckHistory
              key={selected.id}
              deck={selected}
              view={view}
              onChange={change}
              showBack={!wide}
              focusOnMount={guided}
            />
          )}
        </div>
      )}
    </div>
  );
}
