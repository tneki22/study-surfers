import { Play, SquareStack } from "lucide-react";
import { Link } from "react-router";
import type { DeckSummary } from "../api/types";
import { Button } from "../components/ui";
import { plural } from "../screens/plural";
import { useRunLauncher } from "./launch";
import "../styles/resume-project.css";

export function ResumeProject({ deck, error, onRetry }: {
  deck: DeckSummary | null;
  error: boolean;
  onRetry: () => void;
}) {
  const launcher = useRunLauncher();
  const playable = Boolean(deck && deck.enabled_item_count > 0);

  return (
    <div className="resume-project" role="region" aria-label="Продолжить последний проект">
      <span className="resume-project-icon" aria-hidden="true"><SquareStack size={22} /></span>
      <div className="resume-project-info">
        <span className="resume-project-caption">{deck ? "Последний проект" : "Твой следующий забег"}</span>
        {deck ? (
          <Link className="resume-project-title" to={`/decks/${deck.id}`} title={deck.title}>{deck.title}</Link>
        ) : (
          <strong className="resume-project-title">{error ? "Не удалось загрузить проект" : "Сначала создай колоду"}</strong>
        )}
        <span className="resume-project-hint">
          {deck ? playable
            ? `${plural(deck.enabled_item_count, "карточка", "карточки", "карточек")} · Играй с последними настройками`
            : "В этой колоде пока нет активных карточек"
            : "Закинь вопросы, ответы или конспект в поле ниже"}
        </span>
      </div>
      {error && !deck ? (
        <Button variant="secondary" onClick={onRetry}>Повторить</Button>
      ) : (
        <Button className="resume-project-play" disabled={!playable}
          onClick={() => { if (deck) launcher.start(deck.id, { live: deck.status === "generating" }); }}
          title="Быстрый старт с последними настройками">
          <Play size={18} fill="currentColor" aria-hidden="true" /> Играть
        </Button>
      )}
    </div>
  );
}
