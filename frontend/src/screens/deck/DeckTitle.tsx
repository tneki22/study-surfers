import { Pencil } from "lucide-react";
import { useState } from "react";

/**
 * Название колоды, которое правится на месте: клик — поле ввода, Enter или
 * уход фокуса — сохранить, Esc — отменить. Карандаш виден всегда: раньше он
 * появлялся только по наведению, и переименование никто не находил.
 * Название придумывает модель при импорте; дальше его меняют только руками.
 */
export function DeckTitle({ title, onRename, className = "" }: {
  title: string;
  onRename: (title: string) => Promise<void>;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = async () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== title) await onRename(next);
  };
  if (draft !== null) {
    return (
      <form className={`deck-rename ${className}`.trim()} onSubmit={(event) => { event.preventDefault(); void commit(); }}>
        <input
          aria-label="Название колоды"
          value={draft}
          maxLength={120}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commit()}
          onKeyDown={(event) => { if (event.key === "Escape") setDraft(null); }}
        />
      </form>
    );
  }
  return (
    <span className={`deck-title ${className}`.trim()}>
      <button type="button" className="deck-title-button" title="Переименовать колоду" onClick={() => setDraft(title)}>
        {title} <Pencil size="0.75em" aria-hidden="true" />
      </button>
    </span>
  );
}
