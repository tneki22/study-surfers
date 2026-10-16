import { FileJson, FileSpreadsheet } from "lucide-react";
import { api } from "../../api/client";
import type { ExportFormat } from "../../api/types";
import type { MenuItem } from "../../components/ui";

/** Скачивание через ссылку: имя файла задаёт сервер в Content-Disposition. */
export function downloadDeck(deckId: string, format: ExportFormat) {
  const link = document.createElement("a");
  link.href = api.exportDeckUrl(deckId, format);
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
}

/**
 * Два формата выгрузки. `.ssdeck.json` — полная копия колоды Study Surfers (вопросы, ответы,
 * все варианты и пояснения): для резервной копии и чтобы поделиться колодой. Таблица для Anki —
 * вопрос, ответ и пояснение: её открывают Anki (Файл → Импорт), Quizlet и Excel.
 */
export function exportMenuItems(deckId: string): MenuItem[] {
  return [
    { label: "Экспорт для Anki и Quizlet (.txt)", icon: <FileSpreadsheet size={15} aria-hidden="true" />, onSelect: () => downloadDeck(deckId, "anki") },
    { label: "Копия колоды (.ssdeck.json)", icon: <FileJson size={15} aria-hidden="true" />, onSelect: () => downloadDeck(deckId, "ssdeck") },
  ];
}
