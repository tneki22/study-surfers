import { Bot, Home, Play, RotateCcw, Settings2, Star, Trophy } from "lucide-react";
import { MarkdownInline } from "../../markdown/MarkdownView";
import { starsFor } from "../engine/scoring";
import { useHud } from "../store";
import { useRuntime } from "../scene/context";

const number = new Intl.NumberFormat("ru-RU");
const IMPACT_LABELS = [["graze", "задел"], ["hit", "удар"], ["crash", "крушение"]] as const;

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export interface ResultsActions {
  onRetryMistakes: (itemIds: string[]) => void;
  onAgain: () => void;
  onSetup: () => void;
  onExit: () => void;
}

/** Финиш: очки, звёзды, рекорд и разбор ошибок с объяснениями. */
export function Results({ onRetryMistakes, onAgain, onSetup, onExit, saveState }: ResultsActions & { saveState: "saving" | "saved" | "offline" }) {
  const runtime = useRuntime();
  const result = useHud((s) => s.result);
  if (!result) return null;

  const answered = result.correct + result.wrong;
  const accuracy = answered ? Math.round((result.correct / answered) * 100) : 0;
  const stars = starsFor(result.correct, answered);
  const record = result.score > 0 && (result.previousBest === null || result.score > result.previousBest);
  const mistakeIds = [...new Set(result.mistakes.map((m) => m.itemId))];

  return (
    <div className="results-overlay" role="dialog" aria-modal="true" aria-labelledby="results-title">
      <div className="results-card">
        <header className="results-head">
          <h2 id="results-title">{result.finished ? "Финиш!" : "Забег окончен"}</h2>
          <div className="results-stars" aria-label={`Звёзд: ${stars} из 3`}>
            {[0, 1, 2].map((i) => (
              <Star key={i} size={34} className={i < stars ? "is-on" : ""} fill={i < stars ? "currentColor" : "none"} style={{ animationDelay: `${300 + i * 180}ms` }} />
            ))}
          </div>
          <div className="results-score">
            {number.format(result.score)}
            {record && <span className="results-record"><Trophy size={14} aria-hidden="true" /> новый рекорд</span>}
          </div>
        </header>

        <dl className="results-stats">
          <div><dt>Точность</dt><dd>{accuracy}%</dd></div>
          <div><dt>Верно</dt><dd>{result.correct} из {answered}</dd></div>
          <div><dt>Лучшая серия</dt><dd>{result.maxStreak}</dd></div>
          <div><dt>Время</dt><dd>{duration(result.durationMs)}</dd></div>
          {result.obstacles > 0 && (
            <>
              <div><dt>Чистых</dt><dd>{result.obstacles - result.bumps} из {result.obstacles}</dd></div>
              <div><dt>Чистая серия</dt><dd>{result.bestClean}</dd></div>
              <div><dt>{runtime.night ? "Энергия" : "Монеты"}</dt><dd>{result.coins}</dd></div>
              <div className="results-impacts">
                <dt>Столкновения</dt>
                <dd>{result.bumps === 0 ? "ни одного" : IMPACT_LABELS.filter(([key]) => result.impacts[key]).map(([key, label]) => `${label} ${result.impacts[key]}`).join(" · ")}</dd>
              </div>
            </>
          )}
        </dl>

        {result.mistakes.length > 0 ? (
          <section className="results-mistakes" aria-labelledby="mistakes-title">
            <h3 id="mistakes-title">Разбор ошибок</h3>
            <ol>
              {result.mistakes.map((mistake, index) => (
                <li key={`${mistake.itemId}-${index}`}>
                  <p className="mistake-prompt">
                    <MarkdownInline text={mistake.prompt} />
                    {mistake.source === "ai_knowledge" && <span className="board-badge is-ai"><Bot size={12} aria-hidden="true" /> ответ ИИ</span>}
                  </p>
                  <p className="mistake-line is-wrong">
                    <span>Твой ответ</span> <MarkdownInline text={mistake.chosen} />
                    {mistake.whyWrong && <small> — <MarkdownInline text={mistake.whyWrong} /></small>}
                  </p>
                  <p className="mistake-line is-correct"><span>Верно</span> <MarkdownInline text={mistake.correct} /></p>
                  {mistake.explanation && <p className="mistake-explanation"><MarkdownInline text={mistake.explanation} /></p>}
                </li>
              ))}
            </ol>
          </section>
        ) : (
          answered > 0 && <p className="results-clean">Ни одной ошибки — так держать!</p>
        )}

        <footer className="results-actions">
          {mistakeIds.length > 0 && (
            <button type="button" className="primary-button cta-button" onClick={() => onRetryMistakes(mistakeIds)}>
              <RotateCcw size={18} aria-hidden="true" /> Повторить ошибки
            </button>
          )}
          <button type="button" className={mistakeIds.length ? "secondary-button" : "primary-button cta-button"} onClick={onAgain}>
            <Play size={16} fill="currentColor" aria-hidden="true" /> Ещё раз
          </button>
          <button type="button" className="secondary-button" onClick={onSetup}>
            <Settings2 size={16} aria-hidden="true" /> Настройки
          </button>
          <button type="button" className="text-button" onClick={onExit}>
            <Home size={16} aria-hidden="true" /> В меню
          </button>
        </footer>
        <p className="results-save">
          {saveState === "saving" && "Сохраняю результат…"}
          {saveState === "saved" && "Результат сохранён"}
          {saveState === "offline" && "Сервер недоступен — результат отправится при следующем запуске"}
        </p>
      </div>
    </div>
  );
}
