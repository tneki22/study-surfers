import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import type { DeckSummary } from "../../api/types";
import { Button, ConfirmDialog, Dialog, Field, IconButton, Menu } from "../../components/ui";
import { errorText } from "../ai/useAiSettings";
import { plural } from "../plural";
import { exportMenuItems } from "./exportDeck";

/** Меню карточки колоды на главной: переименовать, выгрузить и удалить, не открывая колоду. */
export function DeckMenu({ deck, onChanged }: { deck: DeckSummary; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(deck.title);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generating = deck.status === "generating";

  const rename = async () => {
    const next = title.trim();
    if (!next || next === deck.title) {
      setRenaming(false);
      return;
    }
    try {
      await api.renameDeck(deck.id, next);
      setRenaming(false);
      onChanged();
    } catch (reason) {
      setError(errorText(reason));
    }
  };

  return (
    <>
      <Menu
        label={`Колода «${deck.title}»`}
        tooltip="Ещё"
        trigger={<IconButton label="Действия с колодой" hideNativeTitle><MoreHorizontal size={16} /></IconButton>}
        items={[
          { label: "Переименовать", icon: <Pencil size={15} aria-hidden="true" />, onSelect: () => { setTitle(deck.title); setError(null); setRenaming(true); } },
          ...(api.mock ? [] : exportMenuItems(deck.id).map((item) => ({ ...item, disabled: deck.item_count === 0 }))),
          { label: "Удалить", icon: <Trash2 size={15} aria-hidden="true" />, destructive: true, onSelect: () => { setError(null); setDeleting(true); } },
        ]}
      />
      <Dialog
        open={renaming}
        onOpenChange={setRenaming}
        title="Переименовать колоду"
        footer={
          <>
            <Button variant="ghost" onClick={() => setRenaming(false)}>Отменить</Button>
            <Button type="submit" form={`rename-${deck.id}`} disabled={!title.trim()}>Сохранить</Button>
          </>
        }
      >
        <form id={`rename-${deck.id}`} className="deck-rename-dialog" onSubmit={(event) => { event.preventDefault(); void rename(); }}>
          <Field label="Название" error={error ?? undefined}>
            <input value={title} maxLength={120} autoFocus onFocus={(event) => event.currentTarget.select()} onChange={(event) => setTitle(event.target.value)} />
          </Field>
        </form>
      </Dialog>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        title={`Удалить «${deck.title}»?`}
        confirmLabel="Удалить колоду"
        destructive
        onConfirm={async () => {
          try {
            await api.deleteDeck(deck.id);
            onChanged();
          } catch (reason) {
            setError(errorText(reason));
            throw reason;
          }
        }}
      >
        <p>
          {plural(deck.item_count, "карточка", "карточки", "карточек")} и статистика забегов исчезнут. Исходные файлы на компьютере останутся.
          {generating && " Генерация остановится."}
        </p>
        {error && <p className="form-error" role="alert">{error}</p>}
      </ConfirmDialog>
    </>
  );
}
