import { Bookmark, ChevronDown, Pencil, Plus, SlidersHorizontal, Trash2 } from "lucide-react";
import { Collapsible } from "radix-ui";
import { useEffect, useState } from "react";
import { api } from "../../api/client";
import type { LearnerPresets } from "../../api/types";
import { usePreferences, type CustomPrompt } from "../../app/stores";
import { Button } from "../../components/ui";
import { useLoad } from "../../hooks/useLoad";

const CUSTOM_NAME = "Мой промпт";

/** Готовые фразы о материале и пожеланиях: дописываются в конец промпта. */
const SNIPPETS = [
  {
    label: "Лабораторная: контрольные вопросы",
    text: "Это лабораторная работа. Делай карточки только по контрольным вопросам в конце файла, по одной на вопрос; ответы бери из текста работы.",
  },
  {
    label: "Презентация",
    text: "Это презентация: на слайдах короткие тезисы, готовых вопросов нет. Придумай вопросы сама по содержанию слайдов.",
  },
  { label: "Без дат и фамилий", text: "Не спрашивай даты, фамилии и номера страниц." },
  {
    label: "На применение",
    text: "Больше карточек на применение: конкретный случай или числа, выбор вывода из условий.",
  },
];

export interface LearnerPromptState {
  presets: LearnerPresets | null;
  text: string;
  setText: (text: string) => void;
  /** Выбранный свой пресет: правки текста сразу сохраняются в него. */
  customId: string | null;
  /** Выбрать пресет: свой (id) или готовый (null) — без записи текста в прежний свой. */
  select: (id: string | null, text: string) => void;
  /** Подпись на кнопке: имя пресета или «Свой текст». */
  label: string;
  /** Что отправить в импорт: без изменений пресета по умолчанию — ничего, бэкенд возьмёт свой. */
  value: string | undefined;
}

/**
 * Пожелания к карточкам. Каждое открытие главной начинается с пресета по умолчанию:
 * разовая правка не должна тихо влиять на следующие колоды. Постоянные варианты — свои пресеты.
 */
export function useLearnerPrompt(): LearnerPromptState {
  const { data: presets } = useLoad(() => api.learnerPresets(), []);
  const custom = usePreferences((state) => state.learnerPrompts);
  const update = usePreferences((state) => state.update);
  const [text, setTextState] = useState<string | null>(null);
  const [customId, setCustomId] = useState<string | null>(null);
  const fallback = presets?.presets.find((preset) => preset.id === presets.default_id)?.text ?? "";

  useEffect(() => {
    if (presets && text === null) setTextState(fallback);
  }, [presets, fallback, text]);

  const selected = custom.find((prompt) => prompt.id === customId);
  const setText = (next: string) => {
    setTextState(next);
    if (selected) update({ learnerPrompts: custom.map((p) => (p.id === selected.id ? { ...p, text: next } : p)) });
  };

  const current = (text ?? fallback).trim();
  const match = presets?.presets.find((preset) => preset.text.trim() === current);
  return {
    presets,
    text: text ?? fallback,
    setText,
    customId: selected ? selected.id : null,
    select: (id, next) => {
      setCustomId(id);
      setTextState(next);
    },
    label: selected?.label ?? match?.label ?? "Свой текст",
    value: current && current !== fallback.trim() ? current : undefined,
  };
}

export function LearnerPromptToggle({ label }: { label: string }) {
  return (
    <Collapsible.Trigger className="learner-toggle">
      <SlidersHorizontal size={16} aria-hidden="true" />
      <span className="import-option-text">
        <span className="import-option-label">Промпт</span>
        <small>{label}</small>
      </span>
      <ChevronDown size={16} className="learner-toggle-chevron" aria-hidden="true" />
    </Collapsible.Trigger>
  );
}

/** «Мой промпт N» со следующим свободным номером. */
function nextName(prompts: CustomPrompt[]) {
  const used = new Set(prompts.map((p) => p.label));
  let n = 1;
  while (used.has(`${CUSTOM_NAME} ${n}`)) n += 1;
  return `${CUSTOM_NAME} ${n}`;
}

function NameInput({ fallback, initial, onDone }: { fallback: string; initial: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const finish = () => onDone(value.trim() || fallback);
  return (
    <input
      className="learner-preset learner-preset-name"
      aria-label="Название промпта"
      placeholder={fallback}
      value={value}
      maxLength={40}
      autoFocus
      size={Math.max(value.length, fallback.length, 8)}
      onChange={(event) => setValue(event.target.value)}
      onBlur={finish}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === "Escape") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}

export function LearnerPromptPanel({ state }: { state: LearnerPromptState }) {
  const custom = usePreferences((store) => store.learnerPrompts);
  const update = usePreferences((store) => store.update);
  const [editing, setEditing] = useState<string | null>(null);
  const { presets, text, setText, customId, select } = state;
  const max = presets?.max_length ?? 800;
  const current = text.trim();
  const fallback = presets?.presets.find((preset) => preset.id === presets.default_id)?.text ?? "";
  const selected = custom.find((prompt) => prompt.id === customId);
  const isPreset = presets?.presets.some((preset) => preset.text.trim() === current) ?? false;

  const create = (start: string) => {
    const prompt = { id: `p${Date.now().toString(36)}`, label: nextName(custom), text: start };
    update({ learnerPrompts: [...custom, prompt] });
    select(prompt.id, start);
    setEditing(prompt.id);
  };

  const rename = (id: string, label: string) => {
    update({ learnerPrompts: usePreferences.getState().learnerPrompts.map((p) => (p.id === id ? { ...p, label } : p)) });
    setEditing(null);
  };

  const remove = (id: string) => {
    update({ learnerPrompts: custom.filter((p) => p.id !== id) });
    select(null, fallback);
  };

  const append = (snippet: string) => {
    const joined = current ? `${current}\n${snippet}` : snippet;
    setText(joined.slice(0, max));
  };

  return (
    <Collapsible.Content className="disclosure-content learner-content">
      <div className="learner-prompt">
        <p className="learner-prompt-hint">
          Кто ты в этой теме, что за материал и что из него спрашивать — модель учтёт и при разборе
          файла, и при генерации. Формат карточек, длину ответов и проверки она держит сама.
        </p>
        <div className="learner-presets" role="group" aria-label="Пресеты промпта">
          {presets?.presets.map((option) => (
            <button
              key={option.id}
              type="button"
              className="learner-preset"
              aria-pressed={!selected && option.text.trim() === current}
              onClick={() => select(null, option.text)}
            >
              {option.label}
            </button>
          ))}
          {custom.map((option) =>
            editing === option.id ? (
              <NameInput
                key={option.id}
                fallback={option.label}
                initial={option.label.startsWith(CUSTOM_NAME) ? "" : option.label}
                onDone={(name) => rename(option.id, name)}
              />
            ) : (
              <button
                key={option.id}
                type="button"
                className="learner-preset learner-preset-custom"
                aria-pressed={selected?.id === option.id}
                title="Двойной щелчок — переименовать"
                onClick={() => select(option.id, option.text)}
                onDoubleClick={() => setEditing(option.id)}
              >
                {option.label}
              </button>
            ),
          )}
          <button
            type="button"
            className="learner-preset learner-preset-add"
            aria-label="Новый промпт"
            title="Новый промпт"
            onClick={() => create(fallback)}
          >
            <Plus size={16} aria-hidden="true" />
          </button>
        </div>
        <textarea
          className="paste-area learner-prompt-text"
          aria-label="Пожелания к карточкам"
          value={text}
          maxLength={max}
          rows={4}
          onChange={(event) => setText(event.target.value)}
        />
        <div className="learner-snippets" role="group" aria-label="Дописать в промпт">
          <span className="learner-snippets-label">Дописать:</span>
          {SNIPPETS.map((snippet) => (
            <button
              key={snippet.label}
              type="button"
              className="learner-snippet"
              disabled={text.includes(snippet.text)}
              title={snippet.text}
              onClick={() => append(snippet.text)}
            >
              + {snippet.label}
            </button>
          ))}
        </div>
        <div className="learner-prompt-actions">
          <small className="learner-prompt-count">{text.length}/{max}</small>
          {selected ? (
            <span className="learner-prompt-buttons">
              <Button variant="ghost" onClick={() => setEditing(selected.id)}>
                <Pencil size={15} aria-hidden="true" /> Переименовать
              </Button>
              <Button variant="ghost" onClick={() => remove(selected.id)}>
                <Trash2 size={15} aria-hidden="true" /> Удалить
              </Button>
            </span>
          ) : (
            !isPreset && (
              <Button variant="secondary" disabled={!current} onClick={() => create(text)}>
                <Bookmark size={15} aria-hidden="true" /> Сохранить как свой
              </Button>
            )
          )}
        </div>
      </div>
    </Collapsible.Content>
  );
}
