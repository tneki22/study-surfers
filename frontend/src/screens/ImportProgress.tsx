import { AlertTriangle, Check, Loader2, Play, RotateCw, Settings2 } from "lucide-react";
import { useState } from "react";
import { useParams, useSearchParams, useNavigate } from "react-router";
import { api } from "../api/client";
import type { Job } from "../api/types";
import { useRunLauncher } from "../app/launch";
import { Button, ErrorState, LoadingState, Progress } from "../components/ui";
import { useLoad, usePolling } from "../hooks/useLoad";
import { AiQuickSetup } from "./ai/AiQuickSetup";
import { ImportWarnings } from "./ImportWarnings";
import { analysisLabel, byTopics, foundLine } from "./importSteps";
import { isReadingWarning } from "./readingHelp";

const STEP_COUNT = 3;
const ACTIVE_STATES = new Set<Job["state"]>(["queued", "extracting", "structuring", "awaiting_confirm", "awaiting_executor", "generating"]);

function stepIndex(job: Job): number {
  switch (job.state) {
    case "queued":
    case "extracting":
      return 0;
    case "structuring":
      return 1;
    case "awaiting_confirm":
    case "generating":
    case "awaiting_executor":
      return 2;
    case "failed":
    case "cancelled":
    case "interrupted":
      return job.total > 0 ? 2 : 0;
    default:
      return STEP_COUNT;
  }
}

const money = new Intl.NumberFormat("ru-RU", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export function ImportProgress() {
  const { jobId = "" } = useParams();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const launcher = useRunLauncher();
  const job = useLoad(() => api.getJob(jobId), [jobId]);
  const deckId = job.data?.deck_id ?? params.get("deck") ?? "";
  const deck = useLoad(() => (deckId ? api.getDeck(deckId) : Promise.resolve(null)), [deckId]);
  const active = job.data ? ACTIVE_STATES.has(job.data.state) : true;
  usePolling(job.reload, 1000, active);
  const [needsAi, setNeedsAi] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);

  if (job.error && !job.data) {
    return (
      <div className="screen-narrow">
        <ErrorState message={job.error} title="Не удалось узнать, как идёт подготовка">
          <Button variant="secondary" onClick={job.reload}>Повторить</Button>
        </ErrorState>
      </div>
    );
  }
  if (!job.data) return <LoadingState label="Отправляю файлы" placement="page" />;

  const current = job.data;
  const step = stepIndex(current);
  const finished = current.state === "done";
  const failed = current.state === "failed" || current.state === "cancelled" || current.state === "interrupted";
  const topics = byTopics(current.sources);
  const steps = ["Читаю файлы", analysisLabel(current.sources), "Генерирую карточки"];
  const found = foundLine(current.sources);

  const cancel = async () => {
    await api.cancelJob(current.id);
    job.reload();
  };

  // Остановленную, прерванную рестартом или упавшую задачу можно продолжить: готовые карточки остаются.
  const resume = async () => {
    setActionError(null);
    try {
      await api.resumeJob(current.id);
      job.reload();
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  // Каждый неудачный вопрос — своя маленькая задача; следим за ними уже на экране колоды.
  const retryFailed = async () => {
    setRetrying(true);
    setActionError(null);
    try {
      const questions = await api.listQuestions(current.deck_id);
      for (const question of questions.filter((q) => q.status === "failed")) await api.regenerateQuestion(current.deck_id, question.id);
      navigate(`/decks/${current.deck_id}`);
    } catch (reason) {
      setActionError(reason instanceof Error ? reason.message : String(reason));
      setRetrying(false);
    }
  };
  const modelProblem = current.error && (/^ai_(model_not_configured|disabled|role_disabled|invalid_credentials|credentials_missing)$/.test(current.error.code) || current.error.code.startsWith("ai_subscription_"));
  const fileProblem = !!current.error && (
    ["import_file_invalid", "import_pdf_password"].includes(current.error.code)
    || (current.error.code === "import_no_questions" && current.warnings.some(isReadingWarning))
  );

  return (
    <div className="screen-narrow import-progress">
      <h1>{finished ? "Колода готова" : failed ? "Подготовка остановлена" : "Готовлю колоду"}</h1>
      {deck.data && <p className="screen-lead">{deck.data.title}</p>}

      <ol className="progress-steps">
        {steps.map((label, index) => {
          const state = index < step ? "done" : index === step && active ? "active" : "pending";
          return (
            <li key={index} className={`progress-step is-${state}`}>
              <span className="progress-step-dot" aria-hidden="true">
                {state === "done" ? <Check size={14} /> : state === "active" ? <Loader2 size={14} className="spin" /> : index + 1}
              </span>
              <span>
                {index === 2 && current.total > 0
                  ? `${label}: ${topics ? "тем" : "вопросов"} ${current.done} из ${current.total}, карточек ${current.ready_items}`
                  : label}
              </span>
            </li>
          );
        })}
      </ol>

      {found && <p className="screen-hint">{found}</p>}
      {current.state === "structuring" && <p className="screen-hint" role="status">{current.stage_label}</p>}

      {current.total > 0 && (
        <Progress value={current.done} max={current.total} label={topics ? "Обработано тем" : "Обработано вопросов"} className="import-progress-bar" />
      )}

      {current.state === "awaiting_confirm" && current.estimate && (
        <div className="confirm-cost" role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>
              {current.estimate.cost_usd == null ? "Подтвердите обработку материалов" : `Генерация обойдётся примерно в ${money.format(current.estimate.cost_usd)}`}
            </strong>
            <p>{current.estimate.reasons.join(" · ")}</p>
            <Button onClick={async () => { await api.confirmJob(current.id); job.reload(); }}>Продолжить</Button>
          </div>
        </div>
      )}

      <ImportWarnings warnings={current.warnings} />
      {current.state === "awaiting_executor" && <p className="screen-hint" role="status">Генерацию выполняет ваш чат через MCP. Вернитесь в подключённый Claude или Codex и попросите: «Обработай задачу {current.id} в Study Surfers до завершения». Повторно загружать материалы в чат не нужно.</p>}

      {current.error && (
        <ErrorState message={current.error.detail} title={modelProblem ? "Модель не отвечает или не настроена" : fileProblem ? "Не удалось прочитать материал" : "Что-то пошло не так"}>
          {modelProblem && <Button variant="secondary" onClick={() => setNeedsAi(true)}>Настроить модель</Button>}
          {fileProblem && <Button variant="secondary" onClick={() => navigate("/")}>Загрузить исправленный файл или текст</Button>}
        </ErrorState>
      )}
      {current.state === "interrupted" && !current.error && (
        <p className="screen-hint">Подготовку прервал перезапуск приложения. Готовые карточки сохранены — можно продолжить.</p>
      )}
      {current.failed_questions > 0 && !active && (
        <div className="confirm-cost" role="status">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>Не получилось карточек по {current.failed_questions} {topics ? (current.failed_questions === 1 ? "теме" : "темам") : current.failed_questions === 1 ? "вопросу" : "вопросам"}</strong>
            <p>Модель ответила с ошибкой или прислала слишком мало неверных вариантов. Можно попробовать ещё раз — готовые карточки останутся.</p>
            <Button variant="secondary" disabled={retrying} onClick={retryFailed}>
              <RotateCw size={16} aria-hidden="true" className={retrying ? "spin" : ""} /> {topics ? "Повторить эти темы" : "Повторить эти вопросы"}
            </Button>
          </div>
        </div>
      )}
      {actionError && <p className="form-error" role="alert">{actionError}</p>}

      <div className="import-progress-actions">
        <Button
          className="cta-button"
          disabled={!current.can_play}
          onClick={() => launcher.start(current.deck_id, { live: active })}
        >
          <Play size={18} aria-hidden="true" fill="currentColor" />
          {finished ? "Бежать!" : "Начать забег сейчас"}
        </Button>
        <Button variant="secondary" disabled={!current.can_play} onClick={() => launcher.setup(current.deck_id, active)}>
          <Settings2 size={16} aria-hidden="true" /> Настроить забег
        </Button>
        {active && <Button variant="ghost" onClick={cancel}>Остановить</Button>}
        {failed && !fileProblem && <Button variant="secondary" onClick={resume}><RotateCw size={16} aria-hidden="true" /> Продолжить подготовку</Button>}
        {!active && <Button variant="ghost" onClick={() => navigate(`/decks/${current.deck_id}`)}>Открыть колоду</Button>}
      </div>
      {!current.can_play && active && (
        <p className="screen-hint">Кнопка оживёт, когда будут готовы первые 8 карточек — остальные догрузятся прямо в забег.</p>
      )}
      <AiQuickSetup open={needsAi} onOpenChange={setNeedsAi} onReady={() => { setNeedsAi(false); void resume(); }} />
    </div>
  );
}
