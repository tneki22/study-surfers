import { FileJson, Layers, Play, Settings2, SquareStack, Trophy } from "lucide-react";
import { useRef } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import type { DeckSummary } from "../api/types";
import { useRunLauncher } from "../app/launch";
import { Button, EmptyState, ErrorState, IconButton, LoadingState, StatusBadge, Tooltip } from "../components/ui";
import { useLoad, usePolling } from "../hooks/useLoad";
import { DeckMenu } from "./deck/DeckMenu";
import { FLASHCARD_ACCEPT } from "./FlashcardImport";
import { ImportPanel } from "./home/ImportPanel";
import { plural } from "./plural";

const number = new Intl.NumberFormat("ru-RU");

const cardsLabel = (count: number) => plural(count, "карточка", "карточки", "карточек");

function DeckCard({ deck, onChanged }: { deck: DeckSummary; onChanged: () => void }) {
  const launcher = useRunLauncher();
  const generating = deck.status === "generating";
  const playable = deck.enabled_item_count > 0;

  return (
    <li className="deck-card">
      <Link to={`/decks/${deck.id}`} className="deck-card-main">
        <span className="deck-card-icon" aria-hidden="true"><Layers size={20} /></span>
        <span className="deck-card-text">
          <strong>{deck.title}</strong>
          <span className="deck-card-meta">
            {cardsLabel(deck.enabled_item_count)}
            {deck.best_score !== null && (
              <span className="deck-card-record"><Trophy size={13} aria-hidden="true" /> {number.format(deck.best_score)}</span>
            )}
          </span>
        </span>
        {generating && <StatusBadge tone="info">готовится</StatusBadge>}
        {deck.weak_count > 0 && !generating && <StatusBadge tone="warning">слабых: {deck.weak_count}</StatusBadge>}
      </Link>
      <div className="deck-card-actions">
        <DeckMenu deck={deck} onChanged={onChanged} />
        <IconButton label="Настроить забег" onClick={() => launcher.setup(deck.id, generating)}>
          <Settings2 size={16} />
        </IconButton>
        <Button
          className="run-button"
          disabled={!playable}
          onClick={() => launcher.run(deck.id, generating)}
          title="Настроить и начать забег"
        >
          <Play size={16} aria-hidden="true" fill="currentColor" /> Бежать
        </Button>
      </div>
    </li>
  );
}

export function Home() {
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const flashcardInput = useRef<HTMLInputElement>(null);
  const decks = useLoad(() => api.listDecks(), []);
  const anyGenerating = decks.data?.some((deck) => deck.status === "generating") ?? false;
  usePolling(decks.reload, 3000, anyGenerating);

  const importDeck = async (file: File | undefined) => {
    if (!file) return;
    try {
      const deck = await api.importDeckFile(file);
      navigate(`/decks/${deck.id}`);
    } catch (reason) {
      alert(reason instanceof Error ? reason.message : String(reason));
    }
  };

  return (
    <div className="home">
      <section className="hero">
        <h1 className="graffiti-title" aria-label="Повторение на бегу">
          <span className="graffiti-title-word" aria-hidden="true">Повторение</span>
          <span className="graffiti-title-word graffiti-title-word--blue" aria-hidden="true">на бегу</span>
        </h1>
        <p>
          ИИ соберёт карточки из твоих материалов. Повторяй на бегу, вспоминай на экзамене.
        </p>
      </section>

      <ImportPanel />

      <section className="decks-section" aria-labelledby="decks-title">
        <div className="section-head">
          <h2 id="decks-title">Что повторяем?</h2>
          <div className="section-head-actions">
            <input
              ref={fileInput}
              type="file"
              accept=".json,application/json"
              hidden
              onChange={(event) => importDeck(event.target.files?.[0])}
            />
            <input
              ref={flashcardInput}
              type="file"
              accept={FLASHCARD_ACCEPT}
              hidden
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) navigate("/flashcards", { state: { file } });
              }}
            />
            <Tooltip label="Пакет Anki (.apkg), экспорт Anki или Quizlet (.txt), таблица CSV" side="bottom">
              <Button variant="ghost" onClick={() => flashcardInput.current?.click()}>
                <SquareStack size={16} aria-hidden="true" /> Из Anki / Quizlet
              </Button>
            </Tooltip>
            <Tooltip label="Копия колоды Study Surfers: её выгружает «Экспорт» в меню колоды" side="bottom">
              <Button variant="ghost" onClick={() => fileInput.current?.click()}>
                <FileJson size={16} aria-hidden="true" /> Из копии .ssdeck.json
              </Button>
            </Tooltip>
          </div>
        </div>
        {decks.loading && !decks.data && <LoadingState label="Загружаю колоды" />}
        {decks.error && !decks.data && (
          <ErrorState message={decks.error} title="Сервер не отвечает">
            <Button variant="secondary" onClick={decks.reload}>Повторить</Button>
          </ErrorState>
        )}
        {decks.data && decks.data.length === 0 && (
          <EmptyState title="Пока ни одной колоды">
            <p>Закинь файлы выше — колода появится здесь.</p>
          </EmptyState>
        )}
        {decks.data && decks.data.length > 0 && (
          <ul className="deck-grid">
            {decks.data.map((deck) => <DeckCard key={deck.id} deck={deck} onChanged={decks.reload} />)}
          </ul>
        )}
      </section>
    </div>
  );
}
