import { lazy, Suspense } from "react";
import { usePreferences, type Quality } from "../app/stores";
import { Kbd, SegmentedTabs, Switch } from "../components/ui";
import { gpuInfo, weakGpu } from "../game/gpu";
import { AiSection } from "./ai/AiSection";
import { GpuStatus } from "./settings/GpuStatus";
import { MusicLibrary } from "./settings/MusicLibrary";

// Превью героев тянет three.js и модели — грузим его только на этом экране.
const CharacterLineup = lazy(() => import("./settings/CharacterLineup").then((module) => ({ default: module.CharacterLineup })));

const QUALITY_TABS: { value: Quality; label: string }[] = [
  { value: "auto", label: "Авто" },
  { value: "low", label: "Низкое" },
  { value: "medium", label: "Среднее" },
  { value: "high", label: "Высокое" },
];

function Volume({ label, value, onChange }: { label: string; value: number; onChange: (value: number) => void }) {
  return (
    <label className="setting-row">
      <span className="setting-row-text"><span className="setting-row-label">{label}</span></span>
      <span className="setting-row-control">
        <input
          type="range"
          className="range-input"
          min={0}
          max={100}
          value={Math.round(value * 100)}
          onChange={(event) => onChange(Number(event.target.value) / 100)}
        />
      </span>
    </label>
  );
}

export function SettingsScreen() {
  const prefs = usePreferences();
  const weak = weakGpu(gpuInfo());

  return (
    <div className="screen-narrow settings-screen">
      <h1>Параметры</h1>

      <h2>Графика</h2>
      <div className="settings-card">
        <div className="setting-row">
          <div className="setting-row-text">
            <span className="setting-row-label">Качество</span>
            <small>
              «Авто» выбирает по видеокарте и снижает чёткость и эффекты, если кадров меньше 50 в секунду
              {weak && ". На встроенной графике «Высокое» без затенения (AO) и с чёткостью до 1,25×"}
            </small>
          </div>
          <div className="setting-row-control">
            <SegmentedTabs label="Качество графики" value={prefs.quality} tabs={QUALITY_TABS} onChange={(quality) => prefs.update({ quality })} />
          </div>
        </div>
        <GpuStatus />
        <Switch
          label="Счётчик кадров"
          hint="FPS и видеокарта в углу экрана во время забега"
          checked={prefs.showFps}
          onCheckedChange={(showFps) => prefs.update({ showFps })}
        />
        <Switch
          label="Меньше движения"
          hint="Без тряски камеры, вспышек, конфетти и линий скорости"
          checked={prefs.reducedMotion}
          onCheckedChange={(reducedMotion) => prefs.update({ reducedMotion })}
        />
      </div>

      <h2>Персонаж</h2>
      <div className="settings-card">
        <Suspense fallback={<div className="character-lineup" aria-busy="true" />}>
          <CharacterLineup />
        </Suspense>
        <p className="settings-note">Персонаж для режима «Дневной город». В режиме «Ночной город» ховербайком управляет пилот.</p>
      </div>

      <h2>Звук</h2>
      <div className="settings-card">
        <Switch label="Музыка" checked={prefs.musicEnabled} onCheckedChange={(musicEnabled) => prefs.update({ musicEnabled })} />
        <Volume label="Громкость музыки" value={prefs.musicVolume} onChange={(musicVolume) => prefs.update({ musicVolume })} />
        <Volume label="Громкость эффектов" value={prefs.sfxVolume} onChange={(sfxVolume) => prefs.update({ sfxVolume })} />
        <MusicLibrary />
      </div>

      <h2>Управление</h2>
      <div className="settings-card">
        <ul className="controls-list">
          <li><span><Kbd>A</Kbd> <Kbd>D</Kbd> или <Kbd>←</Kbd> <Kbd>→</Kbd></span> сменить трек</li>
          <li><span><Kbd>1</Kbd>–<Kbd>4</Kbd></span> сразу на нужный трек</li>
          <li><span><Kbd>W</Kbd> <Kbd>↑</Kbd> <Kbd>Пробел</Kbd></span> прыжок через барьер и на крыши вагонеток</li>
          <li><span><Kbd>S</Kbd> <Kbd>↓</Kbd></span> подкат под балку</li>
          <li><span><Kbd>Esc</Kbd> <Kbd>P</Kbd></span> пауза</li>
          <li><span><Kbd>M</Kbd></span> музыка вкл/выкл</li>
        </ul>
        <Switch label="Подсказки клавиш в забеге" checked={prefs.keyHints} onCheckedChange={(keyHints) => prefs.update({ keyHints })} />
      </div>

      <h2>Искусственный интеллект</h2>
      <AiSection />
    </div>
  );
}
