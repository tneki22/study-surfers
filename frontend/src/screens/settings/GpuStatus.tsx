import { Cpu, TriangleAlert } from "lucide-react";
import { StatusBadge, type StatusTone } from "../../components/ui";
import { gpuInfo, type GpuKind } from "../../game/gpu";

const KIND: Record<GpuKind, { label: string; tone: StatusTone }> = {
  discrete: { label: "дискретная", tone: "success" },
  integrated: { label: "встроенная", tone: "warning" },
  software: { label: "без ускорения", tone: "danger" },
  unknown: { label: "не определена", tone: "neutral" },
};

/**
 * На какой видеокарте браузер рисует игру. Ноутбук с RTX по умолчанию отдаёт
 * браузеру встроенную графику — тогда ночной мир тормозит в десятки раз.
 */
export function GpuStatus({ compact = false }: { compact?: boolean }) {
  const gpu = gpuInfo();
  const kind = KIND[gpu.kind];
  return (
    <div className={`gpu-status is-${gpu.kind}`}>
      <div className="setting-row">
        <div className="setting-row-text">
          <span className="setting-row-label"><Cpu size={15} aria-hidden="true" /> Видеокарта браузера</span>
          <small title={gpu.renderer}>{gpu.name || "Браузер не сообщает имя видеокарты"}</small>
        </div>
        <StatusBadge tone={kind.tone}>{kind.label}</StatusBadge>
      </div>
      {gpu.kind === "integrated" && (
        <div className="gpu-advice" role="note">
          <p><TriangleAlert size={15} aria-hidden="true" /> <strong>Игра рисуется на встроенной графике.</strong> Если в ноутбуке есть NVIDIA или AMD Radeon RX, браузеру её нужно назначить вручную.</p>
          {!compact && (
            <>
              <ol>
                <li>Параметры Windows → Система → Дисплей → Графика.</li>
                <li>Найдите Google Chrome или свой браузер. Если его нет в списке, добавьте через «Обзор»: <code>C:\Program Files\Google\Chrome\Application\chrome.exe</code>.</li>
                <li>Для браузера выберите «Высокая производительность» (NVIDIA).</li>
                <li>Полностью закройте браузер, включая значок в трее, и откройте заново.</li>
              </ol>
              <p className="gpu-advice-note">
                Здесь должно появиться имя видеокарты NVIDIA. Проверить можно и на странице <code>chrome://gpu</code>, строка GL_RENDERER.
                Держите ноутбук на зарядке. На ноутбуках ASUS режим GPU в Armoury Crate не должен быть «Эко».
              </p>
            </>
          )}
        </div>
      )}
      {gpu.kind === "software" && (
        <div className="gpu-advice" role="note">
          <p><TriangleAlert size={15} aria-hidden="true" /> <strong>Браузер рисует без видеокарты.</strong> Включите в настройках Chrome: Система → «Использовать графическое ускорение», затем перезапустите браузер.</p>
        </div>
      )}
    </div>
  );
}
