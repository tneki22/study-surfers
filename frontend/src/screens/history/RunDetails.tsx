import { Check, X } from "lucide-react";
import { api } from "../../api/client";
import type { RunDetail, RunMistake } from "../../api/types";
import { Button, ErrorState, LoadingState, StatusBadge } from "../../components/ui";
import { useLoad } from "../../hooks/useLoad";
import { MarkdownInline, MarkdownView } from "../../markdown/MarkdownView";
import { settingFacts } from "./model";

const number = new Intl.NumberFormat("ru-RU");

/**
 * Разбор ошибки целиком из снимка карточки на момент забега: правка или удаление карточки
 * потом ничего здесь не меняет.
 */
function Mistake({ mistake }: { mistake: RunMistake }) {
  const timedOut = mistake.chosen_kind === "timeout";
  return (
    <li className="history-mistake">
      <div className="history-mistake-question">
        <MarkdownView text={mistake.prompt} />
        {mistake.source === "ai_knowledge" && <StatusBadge tone="info">ответ ИИ</StatusBadge>}
      </div>
      <dl className="history-mistake-answers">
        <div className="history-answer is-wrong">
          <dt><X size={14} aria-hidden="true" /> Твой ответ</dt>
          <dd>{timedOut ? <em>Не успел ответить</em> : <MarkdownInline text={mistake.chosen_text} />}</dd>
        </div>
        <div className="history-answer is-right">
          <dt><Check size={14} aria-hidden="true" /> Верный ответ</dt>
          <dd><MarkdownInline text={mistake.correct} /></dd>
        </div>
        {mistake.why_wrong && !timedOut && (
          <div className="history-answer">
            <dt>Почему неверно</dt>
            <dd><MarkdownInline text={mistake.why_wrong} /></dd>
          </div>
        )}
        {mistake.explanation && (
          <div className="history-answer">
            <dt>Объяснение</dt>
            <dd><MarkdownView text={mistake.explanation} /></dd>
          </div>
        )}
      </dl>
    </li>
  );
}

function Facts({ run }: { run: RunDetail }) {
  return (
    <div className="history-facts-group">
      <section aria-label="Итоги забега">
        <h4>Итоги</h4>
        <dl className="history-facts">
          <div><dt>Дистанция</dt><dd>{number.format(Math.round(run.distance))} м</dd></div>
          <div><dt>Лучшая серия</dt><dd>{number.format(run.max_streak)}</dd></div>
        </dl>
      </section>
      <section aria-label="Сохранённые настройки забега">
        <h4>Настройки забега</h4>
        <dl className="history-facts">
          {settingFacts(run.settings).map((fact) => (
            <div key={fact.label}><dt>{fact.label}</dt><dd>{fact.value}</dd></div>
          ))}
        </dl>
      </section>
    </div>
  );
}

/** Подробности одного забега; запрашиваются только когда запись раскрыта. */
export function RunDetails({ runId, panelId }: { runId: string; panelId: string }) {
  const run = useLoad(() => api.getRun(runId), [runId]);

  return (
    <div className="history-run-body" id={panelId}>
      {run.loading && !run.data && <LoadingState label="Загружаю разбор забега" />}
      {run.error && !run.data && (
        <ErrorState title="Не удалось загрузить забег" message={run.error}>
          <div><Button variant="secondary" onClick={run.reload}>Повторить</Button></div>
        </ErrorState>
      )}
      {run.data && (
        <>
          <Facts run={run.data} />
          <section aria-label="Разбор ошибок" className="history-mistakes">
            <h4>Разбор ошибок{run.data.mistakes.length > 0 && ` · ${run.data.mistakes.length}`}</h4>
            {run.data.mistakes.length === 0 ? (
              <p className="history-note">
                {run.data.correct_count + run.data.wrong_count === 0
                  ? "В этом забеге не было ответов."
                  : "Ошибок нет — все ответы верные."}
              </p>
            ) : (
              <ol className="history-mistake-list">
                {run.data.mistakes.map((mistake, index) => <Mistake key={index} mistake={mistake} />)}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}
