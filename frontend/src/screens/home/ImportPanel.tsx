import { FilePlus2, FileText, Upload, X } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useRef, useState, type DragEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../../api/client";
import { ApiError } from "../../api/http";
import type { DocRole, ItemsPerQuestion } from "../../api/types";
import { Button, Disclosure, IconButton, SegmentedTabs, Select } from "../../components/ui";
import { SprayWidget } from "../../components/SprayWidget";
import { AiQuickSetup } from "../ai/AiQuickSetup";
import { LearnerPromptPanel, LearnerPromptToggle, useLearnerPrompt } from "./LearnerPrompt";

const ACCEPT = ".pdf,.docx,.txt,.md,.typ,.tex";
const ROLE_OPTIONS = [
  { value: "auto", label: "Авто" },
  { value: "questions", label: "Вопросы" },
  { value: "answers", label: "Ответы" },
  { value: "combined", label: "Всё вместе" },
  { value: "notes", label: "Конспект" },
];

/** Роль по имени файла: «Вопросы к экзамену.docx» → вопросы. Пусто — пусть решит сервер. */
export function guessRole(filename: string): DocRole | null {
  const name = filename.toLowerCase();
  if (/вопрос|билет|список|question|program/.test(name)) return "questions";
  if (/ответ|answer/.test(name)) return "answers";
  if (/конспект|лекци|notes|lecture/.test(name)) return "notes";
  return null;
}

interface PickedFile {
  file: File;
  role: DocRole | null;
}

const PER_QUESTION: { value: string; label: string }[] = [
  { value: "auto", label: "Авто" },
  { value: "1", label: "1" },
  { value: "3", label: "3" },
  { value: "5", label: "5" },
];

export const PER_QUESTION_HINT = "Сколько разных фактов спросить по одной теме. У каждой карточки свой ответ и 7 неверных — под любую сложность.";

/** Главный сценарий: файлы и/или текст → одна кнопка → колода генерируется, игра стартует по готовности. */
export function ImportPanel() {
  const navigate = useNavigate();
  const input = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<PickedFile[]>([]);
  const [text, setText] = useState("");
  const [showText, setShowText] = useState(false);
  const [perQuestion, setPerQuestion] = useState("auto");
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsAi, setNeedsAi] = useState(false);
  const learner = useLearnerPrompt();

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const picked = [...list].filter((file) => /\.(pdf|docx|txt|md|typ|tex)$/i.test(file.name));
    const rejected = list.length - picked.length;
    setError(rejected ? `Пропущено файлов: ${rejected}. Подходят PDF, DOCX, TXT, MD, Typst (.typ) и LaTeX (.tex). Старый .doc сохраните как DOCX. Для сканов сначала распознайте текст через OCR или попросите другую модель выдать весь материал текстом с читаемыми формулами, а затем загрузите результат.` : null);
    setFiles((current) => [
      ...current,
      ...picked
        .filter((file) => !current.some((c) => c.file.name === file.name && c.file.size === file.size))
        .map((file) => ({ file, role: guessRole(file.name) })),
    ]);
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    addFiles(event.dataTransfer.files);
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const roles = Object.fromEntries(files.filter((f) => f.role).map((f) => [f.file.name, f.role!]));
      // Название колоде придумывает модель по разобранным вопросам; до этого — по имени файла.
      const started = await api.quickImport(files.map((f) => f.file), text, {
        auto_title: true,
        items_per_question: (perQuestion === "auto" ? "auto" : Number(perQuestion)) as ItemsPerQuestion,
        roles: Object.keys(roles).length ? roles : undefined,
        learner_prompt: learner.value,
      });
      navigate(`/import/${started.job_id}?deck=${started.deck_id}`);
    } catch (reason) {
      setBusy(false);
      // Модель не настроена — не ошибка пользователя: предлагаем настроить прямо здесь.
      if (reason instanceof ApiError && ["ai_model_not_configured", "ai_disabled", "ai_role_disabled"].includes(reason.code ?? "")) {
        setNeedsAi(true);
        return;
      }
      setError(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const empty = !files.length && !text.trim();

  return (
    <section className="import-panel" aria-labelledby="import-title">
      <div
        className={`dropzone ${dragging ? "is-dragging" : ""} ${files.length ? "has-files" : ""}`.trim()}
        onDragOver={(event) => {
          event.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
      >
        <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(event) => addFiles(event.target.files)} />
        <div className="dropzone-heading">
          <div className="dropzone-icon" aria-hidden="true"><Upload size={22} /></div>
          <h2 id="import-title">Закинь вопросы, ответы или конспект. И в забег!</h2>
        </div>
        <p className="dropzone-hint">
          Перетащи файлы сюда или <button type="button" className="link-button" onClick={() => input.current?.click()}>выбери на диске</button>:
          {" "}PDF, DOCX, TXT, MD, Typst (.typ), LaTeX (.tex).
        </p>
        <Disclosure summary="Если у тебя конспект, сканы или формулы" className="dropzone-help">
          <p>Нет списка вопросов? ИИ выделит главные темы конспекта и составит по ним карточки.</p>
          <p>Сканы сначала распознай через OCR или попроси другую модель переписать их текстом с читаемыми формулами. Формулы из .typ и .tex модель переведёт для карточек — сверь их с оригиналом.</p>
        </Disclosure>

        {files.length > 0 && (
          <ul className="file-chips">
            {files.map((picked, index) => (
              <li key={`${picked.file.name}-${index}`} className="file-chip">
                <FileText size={16} aria-hidden="true" />
                <span className="file-chip-name" title={picked.file.name}>{picked.file.name}</span>
                <Select
                  ariaLabel={`Что в файле ${picked.file.name}`}
                  value={picked.role ?? "auto"}
                  options={ROLE_OPTIONS}
                  onValueChange={(value) => setFiles((current) => current.map((f, i) => i === index
                    ? { ...f, role: value === "auto" || value === null ? null : value as DocRole }
                    : f))}
                  className="file-chip-role"
                />
                <IconButton label="Убрать файл" onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}>
                  <X size={14} />
                </IconButton>
              </li>
            ))}
          </ul>
        )}

        {showText ? (
          <textarea
            className="paste-area"
            placeholder="Вставь сюда список вопросов, ответы или конспект"
            value={text}
            onChange={(event) => setText(event.target.value)}
            rows={6}
            autoFocus
          />
        ) : (
          <button type="button" className="link-button paste-toggle" onClick={() => setShowText(true)}>
            <FilePlus2 size={15} aria-hidden="true" /> или вставь текст
          </button>
        )}
      </div>

      {/* «Промпт» раскрывается под строкой действий, над разделом колод. */}
      <Collapsible.Root>
        <div className="import-actions">
          <div className="import-options">
            <div className="import-option">
              <span className="import-option-text">
                <span className="import-option-label">Карточек на вопрос</span>
                <small>{PER_QUESTION_HINT}</small>
              </span>
              <SegmentedTabs label="Карточек на вопрос" value={perQuestion} tabs={PER_QUESTION} onChange={setPerQuestion} />
            </div>
            <LearnerPromptToggle label={learner.label} />
          </div>
          <Button className={`cta-button spray-button${busy ? " is-busy" : ""}`} disabled={empty || busy} onClick={submit}>
            <SprayWidget busy={busy} />
            <span>{busy ? "Отправляю…" : "Создать и играть"}</span>
          </Button>
        </div>
        <LearnerPromptPanel state={learner} />
      </Collapsible.Root>
      {error && <p className="form-error" role="alert">{error}</p>}
      <AiQuickSetup
        open={needsAi}
        onOpenChange={setNeedsAi}
        onReady={() => {
          setNeedsAi(false);
          void submit();
        }}
      />
    </section>
  );
}
