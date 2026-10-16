import { ArrowLeft, Bot, CheckCircle2, CircleSlash, Layers, Upload, X } from "lucide-react";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router";
import { api } from "../api/client";
import { ApiError } from "../api/http";
import type {
  FieldMapping,
  FlashcardMode,
  FlashcardNoteType,
  FlashcardOptions,
  FlashcardPreview,
  FlashcardPromptStyle,
  FlashcardSample,
} from "../api/types";
import {
  Button,
  Checkbox,
  Disclosure,
  ErrorState,
  Field,
  IconButton,
  LoadingState,
  RadioCards,
  SegmentedTabs,
  Select,
  StatusBadge,
  Switch,
} from "../components/ui";
import { AiQuickSetup } from "./ai/AiQuickSetup";
import { errorText } from "./ai/useAiSettings";
import { plural } from "./plural";

export const FLASHCARD_ACCEPT = ".apkg,.colpkg,.txt,.tsv,.csv";

const FORMAT_LABEL: Record<FlashcardPreview["format"], string> = {
  anki_package: "Пакет Anki",
  table: "Таблица",
};

const STYLE_TABS: { value: FlashcardPromptStyle; label: string }[] = [
  { value: "auto", label: "Авто" },
  { value: "meaning", label: "«Что означает…?»" },
  { value: "translate", label: "«Как переводится…?»" },
];

const cards = (count: number) => plural(count, "карточка", "карточки", "карточек");

/** Пример заметки в выбранных полях: «apple → яблоко». */
function mappingExample(noteType: FlashcardNoteType, mapping: FieldMapping) {
  const example = noteType.examples[0];
  if (!example) return null;
  const front = example[mapping.question] ?? "";
  const back = mapping.answer === null || mapping.answer === undefined ? "" : example[mapping.answer] ?? "";
  return noteType.cloze ? front : `${front || "…"} → ${back || "…"}`;
}

function NoteTypeCard({ noteType, included, onInclude, onMapping, single }: {
  noteType: FlashcardNoteType;
  included: boolean;
  onInclude: (value: boolean) => void;
  onMapping: (mapping: FieldMapping) => void;
  single: boolean;
}) {
  const mapping = noteType.mapping;
  const fields = noteType.fields.map((name, index) => ({ value: String(index), label: name || `Поле ${index + 1}` }));
  const set = (key: keyof FieldMapping, value: string | null) =>
    onMapping({ ...mapping, [key]: value === null ? null : Number(value) });
  const example = mappingExample(noteType, mapping);
  return (
    <div className={`note-type ${included ? "" : "is-off"}`.trim()}>
      <div className="note-type-head">
        {single
          ? <strong>{noteType.name}</strong>
          : <Checkbox checked={included} onCheckedChange={onInclude} label={<strong>{noteType.name}</strong>} />}
        <StatusBadge tone="neutral">{plural(noteType.count, "заметка", "заметки", "заметок")}</StatusBadge>
        {noteType.cloze && <StatusBadge tone="info">пропуски</StatusBadge>}
      </div>
      {included && (
        <>
          <div className="note-type-fields">
            <Field label={noteType.cloze ? "Текст с пропусками" : "Вопрос"}>
              <Select ariaLabel="Поле вопроса" value={String(mapping.question)} options={fields} onValueChange={(v) => set("question", v ?? "0")} />
            </Field>
            {!noteType.cloze && (
              <Field label="Ответ">
                <Select ariaLabel="Поле ответа" value={mapping.answer === null || mapping.answer === undefined ? null : String(mapping.answer)} options={fields} onValueChange={(v) => set("answer", v)} />
              </Field>
            )}
            <Field label="Пояснение">
              <Select
                ariaLabel="Поле пояснения"
                value={mapping.extra === null || mapping.extra === undefined ? null : String(mapping.extra)}
                options={fields}
                emptyOption="Без пояснения"
                onValueChange={(v) => set("extra", v)}
              />
            </Field>
          </div>
          {noteType.cloze
            ? <p className="note-type-hint">Каждый пропуск <code>{"{{c1::…}}"}</code> станет вопросом с «___», ответ — скрытое слово.</p>
            : example && <p className="note-type-hint">Например: {example}</p>}
        </>
      )}
    </div>
  );
}

function SampleCard({ sample }: { sample: FlashcardSample }) {
  if (sample.plan === "ready") {
    return (
      <li className="flash-sample">
        <span className="flash-sample-tag is-ready"><CheckCircle2 size={13} aria-hidden="true" /> готово</span>
        <strong>{sample.prompt}</strong>
        <span className="flash-sample-options">
          <span className="flash-option is-correct">{sample.correct}</span>
          {(sample.distractors ?? []).slice(0, 4).map((text) => <span key={text} className="flash-option">{text}</span>)}
        </span>
        {sample.explanation && <small>{sample.explanation}</small>}
      </li>
    );
  }
  const ai = sample.plan === "ai";
  return (
    <li className={`flash-sample ${ai ? "" : "is-skipped"}`.trim()}>
      <span className={`flash-sample-tag ${ai ? "is-ai" : "is-skip"}`}>
        {ai ? <Bot size={13} aria-hidden="true" /> : <CircleSlash size={13} aria-hidden="true" />} {ai ? "доработает ИИ" : "пропуск"}
      </span>
      <strong>{sample.front}</strong>
      <span className="flash-sample-back">{sample.back}</span>
      {sample.reason && <small>{sample.reason}</small>}
    </li>
  );
}

/**
 * Мастер импорта флеш-карточек: Anki (.apkg/.colpkg), «Заметки в виде текста» Anki,
 * Quizlet и любые CSV/TSV. Сервер читает файл и на каждое изменение настроек отвечает
 * планом без сохранения: какие карточки готовы сразу, какие доработает модель, какие пропущены.
 */
export function FlashcardImport() {
  const navigate = useNavigate();
  const location = useLocation();
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>((location.state as { file?: File } | null)?.file ?? null);
  const [options, setOptions] = useState<FlashcardOptions>({ mode: "auto", prompt_style: "auto", reverse: false });
  const [preview, setPreview] = useState<FlashcardPreview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [needsAi, setNeedsAi] = useState(false);
  const [aiVersion, setAiVersion] = useState(0);

  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    setLoading(true);
    const timer = setTimeout(() => {
      api.previewFlashcards(file, options)
        .then((result) => {
          if (cancelled) return;
          setPreview(result);
          setError(null);
          setTitle((current) => current ?? result.title);
        })
        .catch((reason) => { if (!cancelled) setError(errorText(reason)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [file, options, aiVersion]);

  const pick = (list: FileList | null) => {
    const next = list?.[0];
    if (!next) return;
    setFile(next);
    setPreview(null);
    setTitle(null);
    setError(null);
    setOptions((current) => ({ ...current, mappings: undefined, excluded_note_types: undefined, decks: undefined }));
  };

  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    setDragging(false);
    pick(event.dataTransfer.files);
  };

  const update = (patch: Partial<FlashcardOptions>) => setOptions((current) => ({ ...current, ...patch }));

  const submit = async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.importFlashcards(file, { ...options, title: title?.trim() || undefined });
      navigate(result.job_id ? `/import/${result.job_id}?deck=${result.deck_id}` : `/decks/${result.deck_id}`);
    } catch (reason) {
      setBusy(false);
      if (reason instanceof ApiError && ["ai_model_not_configured", "ai_disabled", "ai_role_disabled"].includes(reason.code ?? "")) {
        setNeedsAi(true);
        return;
      }
      setError(errorText(reason));
    }
  };

  const excluded = new Set(options.excluded_note_types ?? []);
  const chosenDecks = options.decks ?? preview?.decks.map((d) => d.name) ?? [];
  const counts = preview?.counts;
  const usable = counts ? counts.ready + counts.ai : 0;

  return (
    <div className="screen-narrow flashcard-import">
      <Link to="/" className="back-link"><ArrowLeft size={16} aria-hidden="true" /> На главную</Link>
      <h1>Карточки из Anki и Quizlet</h1>
      <p className="screen-lead">
        Вопрос и ответ с карточки станут воротами забега. Неверные варианты для коротких ответов берём из других карточек колоды,
        длинные карточки может переписать модель.
      </p>

      <input ref={input} type="file" accept={FLASHCARD_ACCEPT} hidden onChange={(event) => { pick(event.target.files); event.target.value = ""; }} />
      {!file ? (
        <div
          className={`dropzone flash-dropzone ${dragging ? "is-dragging" : ""}`.trim()}
          onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={onDrop}
        >
          <div className="dropzone-icon" aria-hidden="true"><Upload size={26} /></div>
          <h2>Перетащи файл с карточками</h2>
          <p className="dropzone-hint">
            Или <button type="button" className="link-button" onClick={() => input.current?.click()}>выбери на диске</button>.
            {" "}Пакет Anki (.apkg, .colpkg), текст из Anki или Quizlet (.txt), таблица (.csv, .tsv).
          </p>
        </div>
      ) : (
        <div className="file-chip flash-file">
          <Layers size={16} aria-hidden="true" />
          <span className="file-chip-name" title={file.name}>{file.name}</span>
          {preview && <StatusBadge tone="neutral">{FORMAT_LABEL[preview.format]}</StatusBadge>}
          <Button variant="ghost" onClick={() => input.current?.click()}>Другой файл</Button>
          <IconButton label="Убрать файл" onClick={() => { setFile(null); setPreview(null); setTitle(null); setError(null); }}>
            <X size={14} />
          </IconButton>
        </div>
      )}

      <Disclosure summary="Как выгрузить карточки из Anki и Quizlet" className="flash-howto">
        <ul>
          <li><b>Anki:</b> Файл → Экспорт → «Колода Anki (.apkg)». Медиафайлы можно не включать: картинки и звук в забеге не показываются.</li>
          <li><b>Anki, текстом:</b> Файл → Экспорт → «Заметки в виде простого текста (.txt)».</li>
          <li><b>Quizlet:</b> модуль → «…» → Экспорт, разделитель «Табуляция» между термином и определением, «Новая строка» между карточками. Текст сохрани в .txt.</li>
          <li><b>Excel или Google Таблицы:</b> сохрани как CSV: первый столбец — вопрос, второй — ответ, третий по желанию — пояснение.</li>
        </ul>
      </Disclosure>

      {file && !preview && loading && <LoadingState label="Читаю карточки" />}
      {file && !preview && error && <ErrorState message={error} title="Не удалось прочитать файл" />}

      {preview && (
        <div className={`flash-wizard ${loading ? "is-updating" : ""}`.trim()} aria-busy={loading}>
          <section className="settings-card flash-step">
            <h2><span className="flash-step-number">1</span> Что взять из файла</h2>
            {preview.note_types.map((noteType) => (
              <NoteTypeCard
                key={noteType.id}
                noteType={noteType}
                single={preview.note_types.length === 1}
                included={!excluded.has(noteType.id)}
                onInclude={(value) => update({
                  excluded_note_types: value ? [...excluded].filter((id) => id !== noteType.id) : [...excluded, noteType.id],
                })}
                onMapping={(mapping) => update({ mappings: { ...options.mappings, [noteType.id]: mapping } })}
              />
            ))}
            {preview.decks.length > 1 && (
              <div className="flash-decks">
                <span className="setting-row-label">Колоды Anki</span>
                <ul>
                  {preview.decks.map((deck) => (
                    <li key={deck.name}>
                      <Checkbox
                        checked={chosenDecks.includes(deck.name)}
                        onCheckedChange={(value) => update({
                          decks: value ? [...chosenDecks, deck.name] : chosenDecks.filter((name) => name !== deck.name),
                        })}
                        label={<>{deck.name.replaceAll("::", " › ")} <small>{deck.count}</small></>}
                      />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>

          <section className="settings-card flash-step">
            <h2><span className="flash-step-number">2</span> Как сделать ворота</h2>
            <RadioCards<FlashcardMode>
              label="Откуда неверные варианты"
              layout="rows"
              value={options.mode ?? "auto"}
              onChange={(mode) => update({ mode })}
              options={[
                {
                  value: "auto",
                  title: "Авто",
                  description: preview.ai_ready
                    ? "Короткие ответы — сразу, варианты из других карточек. Длинные перепишет модель"
                    : "Короткие ответы — сразу. Для длинных нужна модель — пока она не настроена, их пропустим",
                },
                { value: "local", title: "Без ИИ", description: "Мгновенно и бесплатно. Что не подходит для ворот — пропустим" },
                {
                  value: "ai",
                  title: "Всё через ИИ",
                  description: "Модель перепишет каждую карточку и придумает правдоподобные ошибки. Дольше и стоит токенов",
                  unavailableReason: preview.ai_ready ? undefined : "Нужна модель: нажми «Настроить модель» ниже",
                },
              ]}
            />
            {!preview.ai_ready && (
              <Button variant="ghost" onClick={() => setNeedsAi(true)}><Bot size={16} aria-hidden="true" /> Настроить модель</Button>
            )}
            <div className="setting-row">
              <div className="setting-row-text">
                <span className="setting-row-label">Короткая лицевая сторона</span>
                <small>Авто: слово короче 8 букв становится вопросом «Что означает «apple»?», остальное — как есть</small>
              </div>
              <div className="setting-row-control">
                <SegmentedTabs<FlashcardPromptStyle>
                  label="Формулировка вопроса"
                  value={options.prompt_style ?? "auto"}
                  tabs={STYLE_TABS}
                  onChange={(prompt_style) => update({ prompt_style })}
                />
              </div>
            </div>
            <Switch
              label="Ещё и обратные карточки"
              hint="Ответ → вопрос: для слов и терминов учит в обе стороны"
              checked={options.reverse ?? false}
              onCheckedChange={(reverse) => update({ reverse })}
            />
          </section>

          <section className="settings-card flash-step">
            <h2><span className="flash-step-number">3</span> Что получится</h2>
            {counts && (
              <ul className="flash-counts">
                <li className="is-ready"><strong>{counts.ready}</strong><span>готовы сразу</span></li>
                <li className="is-ai"><strong>{counts.ai}</strong><span>доработает ИИ</span></li>
                <li className="is-skip"><strong>{counts.skipped}</strong><span>пропущено</span></li>
              </ul>
            )}
            {preview.reasons.length > 0 && (
              <ul className="flash-reasons">
                {preview.reasons.map((reason) => (
                  <li key={`${reason.plan}-${reason.reason}`}>
                    {reason.plan === "ai" ? <Bot size={14} aria-hidden="true" /> : <CircleSlash size={14} aria-hidden="true" />}
                    <span>{reason.reason}</span>
                    <b>{reason.count}</b>
                  </li>
                ))}
              </ul>
            )}
            {preview.samples.length > 0 && <ul className="flash-samples">{preview.samples.map((sample, index) => <SampleCard key={index} sample={sample} />)}</ul>}
          </section>

          <div className="flash-submit">
            <Field label="Название колоды">
              <input value={title ?? ""} maxLength={120} onChange={(event) => setTitle(event.target.value)} />
            </Field>
            <Button className="cta-button" disabled={busy || usable === 0 || !title?.trim()} onClick={submit}>
              <Layers size={18} aria-hidden="true" /> {busy ? "Создаю…" : usable ? `Создать колоду · ${cards(usable)}` : "Нечего импортировать"}
            </Button>
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
      )}

      <AiQuickSetup
        open={needsAi}
        onOpenChange={setNeedsAi}
        onReady={() => { setNeedsAi(false); setAiVersion((value) => value + 1); }}
      />
    </div>
  );
}
