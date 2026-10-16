import { useEffect, useState } from "react";
import { api } from "../../api/client";
import { ApiError } from "../../api/http";
import type { Distractor, QuizItem } from "../../api/types";
import { Button, Dialog, Field } from "../../components/ui";

/**
 * Правка карточки руками: вопрос, верный ответ, объяснение и тексты неверных
 * вариантов. Сервер проверяет её теми же правилами, что и сгенерированные
 * (длины, формулы, ответ не в вопросе) — замечания показываем списком.
 */
export function ItemEditor({ item, onClose, onSaved }: {
  item: QuizItem | null;
  onClose: () => void;
  onSaved: (item: QuizItem) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [correct, setCorrect] = useState("");
  const [explanation, setExplanation] = useState("");
  const [distractors, setDistractors] = useState<Distractor[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!item) return;
    setPrompt(item.prompt);
    setCorrect(item.correct);
    setExplanation(item.explanation);
    setDistractors(item.distractors.map((d) => ({ ...d })));
    setIssues([]);
  }, [item]);

  const save = async () => {
    if (!item) return;
    setBusy(true);
    setIssues([]);
    try {
      const saved = await api.patchItem(item.id, { prompt, correct, explanation, distractors });
      onSaved(saved);
    } catch (reason) {
      const list = reason instanceof ApiError && Array.isArray(reason.context.issues) ? reason.context.issues.map(String) : [];
      setIssues(list.length ? list : [reason instanceof Error ? reason.message : String(reason)]);
    } finally {
      setBusy(false);
    }
  };

  const setDistractor = (index: number, patch: Partial<Distractor>) =>
    setDistractors((current) => current.map((d, i) => (i === index ? { ...d, ...patch } : d)));

  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Правка карточки"
      description="Формулы — в $…$. Похожие неверные варианты делают карточку сложной, явно неверные — лёгкой."
      className="item-editor"
      footer={(
        <>
          <Button variant="ghost" onClick={onClose}>Отмена</Button>
          <Button disabled={busy} onClick={save}>{busy ? "Сохраняю…" : "Сохранить"}</Button>
        </>
      )}
    >
      <Field label="Вопрос" hint="До 160 знаков, без ответа внутри">
        <textarea rows={2} value={prompt} onChange={(event) => setPrompt(event.target.value)} />
      </Field>
      <Field label="Верный ответ" hint="До 70 знаков">
        <input value={correct} onChange={(event) => setCorrect(event.target.value)} />
      </Field>
      {(["near", "far"] as const).map((kind) => (
        <fieldset key={kind} className="distractor-edit">
          <legend>{kind === "near" ? "Похожие неверные" : "Явно неверные"}</legend>
          {distractors.map((d, index) => d.kind === kind && (
            <div key={index} className="distractor-edit-row">
              <input aria-label="Неверный вариант" value={d.text} onChange={(event) => setDistractor(index, { text: event.target.value })} />
              <input aria-label="Почему неверно" className="why" value={d.why_wrong} onChange={(event) => setDistractor(index, { why_wrong: event.target.value })} />
            </div>
          ))}
        </fieldset>
      ))}
      <Field label="Объяснение" hint="1–2 предложения: почему верный ответ верен">
        <textarea rows={3} value={explanation} onChange={(event) => setExplanation(event.target.value)} />
      </Field>
      {issues.length > 0 && (
        <ul className="form-error item-issues" role="alert">
          {issues.map((issue) => <li key={issue}>{issue}</li>)}
        </ul>
      )}
    </Dialog>
  );
}
