import { ArrowLeft, FolderOpen, Sparkles } from "lucide-react";
import { useState } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client";
import { ApiError } from "../api/http";
import type { ItemsPerQuestion, TentexProject } from "../api/types";
import { Button, Checkbox, EmptyState, ErrorState, LoadingState, SegmentedTabs, StatusBadge } from "../components/ui";
import { useLoad } from "../hooks/useLoad";
import { AiQuickSetup } from "./ai/AiQuickSetup";
import { PER_QUESTION_HINT } from "./home/ImportPanel";
import { errorText } from "./ai/useAiSettings";

const PER_QUESTION = [
  { value: "auto", label: "Авто" },
  { value: "1", label: "1" },
  { value: "3", label: "3" },
  { value: "5", label: "5" },
];

const date = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" });

/**
 * Колода из проекта Tentex: вопросы программы, эталонные ответы и карточки
 * превращаются в игровые карточки моделью генерации. База Tentex только читается;
 * если Tentex запущен, просим закрыть его (или прочитать как есть).
 */
export function TentexImport() {
  const navigate = useNavigate();
  const [force, setForce] = useState(false);
  const status = useLoad(() => api.tentex.status(), []);
  const projects = useLoad(
    () => (status.data?.db_found && (!status.data.running || force) ? api.tentex.projects(force) : Promise.resolve(null)),
    [status.data, force],
  );
  const [chosen, setChosen] = useState<TentexProject | null>(null);
  const [perQuestion, setPerQuestion] = useState("auto");
  const [useAnswers, setUseAnswers] = useState(true);
  const [useCards, setUseCards] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAi, setNeedsAi] = useState(false);

  const start = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const started = await api.tentex.importProject(chosen.id, {
        items_per_question: (perQuestion === "auto" ? "auto" : Number(perQuestion)) as ItemsPerQuestion,
        use_answers: useAnswers,
        use_cards: useCards,
        title: chosen.name,
      }, force);
      navigate(`/import/${started.job_id}?deck=${started.deck_id}`);
    } catch (reason) {
      setBusy(false);
      if (reason instanceof ApiError && ["ai_model_not_configured", "ai_disabled"].includes(reason.code ?? "")) setNeedsAi(true);
      else setError(errorText(reason));
    }
  };

  const running = status.data?.running && !force;

  return (
    <div className="screen-narrow tentex-import">
      <Link to="/" className="back-link"><ArrowLeft size={16} aria-hidden="true" /> На главную</Link>
      <h1>Колода из Tentex</h1>
      <p className="screen-lead">Вопросы программы, ответы и карточки проекта станут игровыми карточками. В Tentex ничего не меняется.</p>

      {status.loading && !status.data && <LoadingState label="Ищу Tentex" />}
      {status.error && <ErrorState message={status.error} />}
      {status.data && !status.data.db_found && (
        <EmptyState title="Tentex не найден" icon={<FolderOpen size={28} aria-hidden="true" />}>
          <p>Ищу базу в <code>{status.data.root}</code>. Если Tentex лежит в другом месте, укажите папку в переменной <code>SS_TENTEX_ROOT</code> и перезапустите Study Surfers.</p>
        </EmptyState>
      )}
      {running && (
        <div className="confirm-cost" role="alert">
          <div>
            <strong>Tentex сейчас запущен</strong>
            <p>Пока он пишет в базу, данные могут быть неполными. Закройте Tentex и обновите страницу — или прочитайте как есть.</p>
            <Button variant="secondary" onClick={() => setForce(true)}>Прочитать как есть</Button>
          </div>
        </div>
      )}

      {projects.loading && status.data?.db_found && !running && !projects.data && <LoadingState label="Читаю проекты" />}
      {projects.error && <ErrorState message={projects.error} />}
      {projects.data && projects.data.length === 0 && <EmptyState title="В Tentex нет экзаменационных проектов" />}
      {projects.data && projects.data.length > 0 && (
        <ul className="tentex-projects">
          {projects.data.map((project) => (
            <li key={project.id}>
              <button
                type="button"
                className={`tentex-project ${chosen?.id === project.id ? "is-chosen" : ""}`.trim()}
                aria-pressed={chosen?.id === project.id}
                onClick={() => setChosen(project)}
              >
                <strong>{project.name}</strong>
                <span className="tentex-project-meta">
                  <StatusBadge tone="neutral">вопросов: {project.question_count}</StatusBadge>
                  {project.answer_count > 0 && <StatusBadge tone="success">ответов: {project.answer_count}</StatusBadge>}
                  {project.card_count > 0 && <StatusBadge tone="info">карточек: {project.card_count}</StatusBadge>}
                  <small>изменён {date.format(new Date(project.updated_at))}</small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {chosen && (
        <div className="settings-card tentex-options">
          <div className="setting-row">
            <span className="setting-row-text">
              <span className="setting-row-label">Карточек на вопрос</span>
              <small>{PER_QUESTION_HINT}</small>
            </span>
            <SegmentedTabs label="Карточек на вопрос" value={perQuestion} tabs={PER_QUESTION} onChange={setPerQuestion} />
          </div>
          <Checkbox checked={useAnswers} onCheckedChange={setUseAnswers} label="Опираться на эталонные ответы проекта" />
          <Checkbox checked={useCards} onCheckedChange={setUseCards} label="Превратить карточки Tentex в игровые" />
          <Button className="cta-button" disabled={busy} onClick={start}>
            <Sparkles size={18} aria-hidden="true" /> {busy ? "Запускаю…" : `Сделать колоду «${chosen.name}»`}
          </Button>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      )}

      <AiQuickSetup open={needsAi} onOpenChange={setNeedsAi} onReady={() => { setNeedsAi(false); void start(); }} />
    </div>
  );
}
