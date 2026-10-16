import { Download, MessageSquare } from "lucide-react";
import { useState } from "react";
import { api } from "../../api/client";
import { Button, Disclosure } from "../../components/ui";
import type { useAiSettings } from "./useAiSettings";

export function McpSettings({ run, busy }: {
  run: ReturnType<typeof useAiSettings>["run"];
  busy: string | null;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  return (
    <Disclosure summary="Дополнительно: подключить Study Surfers к чату через MCP" className="settings-card">
      <p className="screen-hint">Для генерации обычной кнопкой достаточно подписки выше. MCP нужен, если вы хотите поручать создание колод своему открытому чату Claude или Codex. Материалы из Study Surfers будут доступны чату без повторной загрузки.</p>
      <div className="subscription-actions">
        {(["codex", "claude"] as const).map((client) => <Button key={client} variant="secondary" disabled={!!busy} onClick={async () => {
          const result = await run(`mcp:${client}`, () => api.ai.installMcp(client));
          if (result) setNotice(result.detail);
        }}><MessageSquare size={16} aria-hidden="true" />{busy === `mcp:${client}` ? "Подключаю…" : `Добавить в ${client === "codex" ? "Codex" : "Claude Code"}`}</Button>)}
        <a className="subscription-link" href="/api/settings/ai/mcp/extension" download="Study-Surfers.mcpb"><Download size={16} aria-hidden="true" /> Пакет для Claude Desktop</a>
      </div>
      {notice && <p role="status" className="screen-hint">{notice}</p>}
      <p className="screen-hint">После добавления перезапустите клиент или начните новый чат. Для Claude Desktop скачайте пакет и откройте «Settings → Extensions → Advanced settings → Install Extension». Пакет создан для установленного здесь Study Surfers; после переноса программы скачайте его заново.</p>
      <p className="screen-hint">Оставьте Study Surfers запущенным. Попросите в чате: «Найди мою колоду в Study Surfers и создай карточки из её материалов через MCP. Выполняй задания до завершения». Чтобы продолжить остановленный импорт, укажите его номер с экрана подготовки. Сервер проверит ответы и сохранит карточки в обычную колоду.</p>
    </Disclosure>
  );
}
