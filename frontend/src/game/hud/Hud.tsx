import { ArrowDown, ArrowLeftRight, ArrowUp, ChevronDown, ChevronUp, Coins, Flame, Heart, Pause, Play, RotateCcw, Siren, Zap, X as Close } from "lucide-react";
import { type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePreferences } from "../../app/stores";
import { Kbd } from "../../components/ui";
import { MarkdownInline } from "../../markdown/MarkdownView";
import { CHASE_SECONDS } from "../engine/impact";
import { comboTierStart, nextComboAt } from "../engine/scoring";
import { MAX_SPEED_FACTOR } from "../engine/speed";
import { gpuInfo } from "../gpu";
import { useRuntime } from "../scene/context";
import { useHud, type AnswerResult } from "../store";
import { AnswerCards } from "./AnswerCards";
import { QuestionBoard } from "./QuestionBoard";
import { ModifierHud } from "./ModifierHud";
import { AudioControls } from "./AudioControls";

const number = new Intl.NumberFormat("ru-RU");
/** Телефон или планшет: управляем свайпами, клавиатурных подсказок не показываем. */
const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

function ScorePanel() {
  const runtime = useRuntime();
  const score = useHud((s) => s.score);
  const pop = useHud((s) => s.pop);
  const coins = useHud((s) => s.coins);
  const obstacles = useHud((s) => s.obstacles);
  return (
    <div className="hud-score">
      <span className="hud-score-value">{number.format(score)}</span>
      {pop && (
        <span key={`pop-${pop.key}`} className={`hud-score-pop ${pop.delta >= 0 ? "is-plus" : "is-minus"}`}>
          {pop.delta >= 0 ? "+" : "−"}{number.format(Math.abs(pop.delta))}
          {pop.multiplier !== undefined && pop.multiplier > 1 && <small>×{pop.multiplier}</small>}
        </span>
      )}
      {obstacles && (
        <span className="hud-coins" key={`coins-${coins}`} aria-label={`${runtime.night ? "Энергия" : "Монеты"}: ${coins}`}>
          {runtime.night ? <Zap size={14} aria-hidden="true" /> : <Coins size={14} aria-hidden="true" />} {coins}
        </span>
      )}
      <ChaseIndicator />
      <ComboMeter />
    </div>
  );
}

/**
 * Множитель, серия и деления до следующего множителя. Смена множителя пересоздаёт
 * таблетку — она «впрыгивает» в новом цвете; обрыв длинной серии её встряхивает.
 */
function ComboMeter() {
  const multiplier = useHud((s) => s.multiplier);
  const streak = useHud((s) => s.streak);
  const lastResult = useHud((s) => s.lastResult);
  const next = nextComboAt(streak);
  const start = comboTierStart(streak);
  const broke = lastResult && !lastResult.correct && lastResult.lostStreak >= 3 ? lastResult : null;
  const label = next === null ? `Комбо ×${multiplier}, максимум. Серия ${streak}` : `Комбо ×${multiplier}, ещё ${next - streak} до ×${multiplier + 1}`;
  return (
    <div
      key={broke ? `broke-${broke.key}` : `tier-${multiplier}`}
      className={`hud-combo is-tier-${multiplier} ${multiplier > 1 ? "is-hot" : ""} ${broke ? "is-broken" : ""}`}
      role="status"
      aria-label={label}
      title={label}
    >
      <Flame size={14} aria-hidden="true" />
      <span className="hud-combo-mult">×{multiplier}</span>
      {next !== null && streak > 0 && (
        <span className="hud-combo-pips" aria-hidden="true">
          {Array.from({ length: next - start }, (_, i) => <i key={i} className={start + i < streak ? "is-on" : ""} />)}
        </span>
      )}
      {streak >= 2 && <span className="hud-combo-streak" key={streak} aria-hidden="true">{streak} подряд</span>}
      {broke && <span className="hud-combo-broke" aria-hidden="true">серия {broke.lostStreak} прервана</span>}
    </div>
  );
}

/** «На хвосте» после столкновения: полоска тает за CHASE_SECONDS, пока следующее столкновение сильнее. */
function ChaseIndicator() {
  const runtime = useRuntime();
  const chase = useHud((s) => s.chase);
  if (!chase) return null;
  return (
    <div
      className={`hud-chase is-${chase.severity}`}
      key={chase.key}
      role="status"
      aria-label={`${runtime.night ? "Патруль" : "Контролёр"} на хвосте: следующий удар сильнее`}
      title="Следующее столкновение — на ступень сильнее"
      style={{ ["--chase-seconds" as string]: `${CHASE_SECONDS}s` }}
    >
      <Siren size={14} aria-hidden="true" />
      <span>На хвосте!</span>
      <i aria-hidden="true" />
    </div>
  );
}

function Lives() {
  const lives = useHud((s) => s.lives);
  const maxLives = useHud((s) => s.maxLives);
  if (maxLives === null || lives === null) return null;
  return (
    <div className="hud-lives" aria-label={`Жизни: ${lives} из ${maxLives}`}>
      {Array.from({ length: maxLives }, (_, i) => (
        <Heart key={i} size={20} className={i < lives ? "is-full" : "is-empty"} fill={i < lives ? "currentColor" : "none"} aria-hidden="true" />
      ))}
    </div>
  );
}

function RouteProgress() {
  const timeline = useHud((s) => s.timeline);
  const total = useHud((s) => s.plannedTotal);
  const slots = Math.max(total, timeline.length, 1);
  const progress = Math.min(1, timeline.length / slots);
  return (
    <div className="route" aria-hidden="true">
      <div className="route-track">
        {Array.from({ length: slots }, (_, i) => (
          <span key={i} className={`route-tick ${i < timeline.length ? (timeline[i] ? "is-correct" : "is-wrong") : ""}`} />
        ))}
      </div>
      <span className="route-runner" style={{ left: `${progress * 100}%` }} />
    </div>
  );
}

function MistakeToast() {
  const lastResult = useHud((s) => s.lastResult);
  const [shown, setShown] = useState<typeof lastResult>(null);
  useEffect(() => {
    if (!lastResult || lastResult.correct) {
      setShown(null);
      return;
    }
    setShown(lastResult);
    const timer = setTimeout(() => setShown(null), 4800);
    return () => clearTimeout(timer);
  }, [lastResult]);
  if (!shown) return null;
  return (
    <div className="mistake-toast" key={shown.key} role="status">
      <span className="mistake-toast-label">Верно:</span>
      <span className="mistake-toast-correct"><MarkdownInline text={shown.correctText} /></span>
      {shown.whyWrong && (
        <span className="mistake-toast-why">
          <MarkdownInline text={shown.chosenText} /> — <MarkdownInline text={shown.whyWrong} />
        </span>
      )}
    </div>
  );
}

const TIER_WORD: Record<number, string> = { 2: "Хорошо!", 3: "Отлично!", 4: "Огонь!", 5: "Неудержимо!" };
const SPARKS: Record<number, number> = { 2: 8, 3: 14, 4: 20, 5: 26 };
const FLAMES = 6;
const MEDAL_COINS = 14;

/**
 * Новый множитель. Чем он выше, тем больше слоёв: ×2 — искры, ×3 — кольцо и блик
 * по надписи, ×4 — лучи и языки пламени, ×5 — двойные лучи, вспышка-полоса и
 * переливы цвета. Всё гаснет за паузу между вопросами и не ловит клики.
 */
function ComboBanner() {
  const lastResult = useHud((s) => s.lastResult);
  const reducedMotion = usePreferences((s) => s.reducedMotion);
  if (!lastResult?.correct) return null;
  if (lastResult.bonus > 0) return <StreakMedal result={lastResult} reducedMotion={reducedMotion} />;
  if (!lastResult.comboUp) return null;
  const tier = Math.min(lastResult.multiplier, 5);
  const count = reducedMotion ? 0 : SPARKS[tier] ?? 8;
  const motion = !reducedMotion;
  return (
    <div className={`combo-banner is-tier-${tier}`} key={lastResult.key} role="status">
      {motion && tier >= 5 && <span className="combo-flare" aria-hidden="true" />}
      {motion && tier >= 5 && <span className="combo-rays is-back" aria-hidden="true" />}
      {motion && tier >= 4 && <span className="combo-rays" aria-hidden="true" />}
      {motion && tier >= 3 && <span className="combo-ring" aria-hidden="true" />}
      {motion && tier >= 5 && <span className="combo-ring is-late" aria-hidden="true" />}
      {motion && tier >= 4 && (
        <span className="combo-flames" aria-hidden="true">
          {Array.from({ length: FLAMES }, (_, i) => (
            <i key={i} style={{ ["--fx" as string]: `${(i - (FLAMES - 1) / 2) * 34}px`, animationDelay: `${(i % 3) * 60}ms` }} />
          ))}
        </span>
      )}
      <span className="combo-banner-word">{TIER_WORD[tier] ?? "Комбо!"}</span>
      <strong className="combo-banner-title" data-text={`Комбо ×${tier}`}>Комбо ×{tier}</strong>
      {Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2 + (i % 2 ? 0.18 : -0.12);
        const distance = (i % 3 === 0 ? 150 : 110) * (1 + (tier - 2) * 0.12);
        return (
          <i
            key={i}
            className="combo-spark"
            aria-hidden="true"
            style={{ ["--x" as string]: `${Math.cos(angle) * distance}px`, ["--y" as string]: `${Math.sin(angle) * distance * 0.6}px`, animationDelay: `${(i % 4) * 25}ms` }}
          />
        );
      })}
    </div>
  );
}

/**
 * Веха серии (10, 15, 20… подряд) — не баннер, а медаль: печать с числом,
 * фонтан монет и бонус, который улетает в счёт.
 */
function StreakMedal({ result, reducedMotion }: { result: AnswerResult; reducedMotion: boolean }) {
  const bonusRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const bonus = bonusRef.current;
    const score = document.querySelector(".hud-score-value");
    if (!bonus || !score) return;
    const from = bonus.getBoundingClientRect();
    const to = score.getBoundingClientRect();
    bonus.style.setProperty("--to-x", `${to.left + to.width / 2 - (from.left + from.width / 2)}px`);
    bonus.style.setProperty("--to-y", `${to.top + to.height / 2 - (from.top + from.height / 2)}px`);
  }, [result.key]);
  return (
    <div className="streak-medal" key={result.key} role="status" aria-label={`Серия ${result.streak} подряд, бонус ${result.bonus}`}>
      {!reducedMotion && <span className="streak-medal-flare" aria-hidden="true" />}
      {!reducedMotion && <span className="streak-medal-wave" aria-hidden="true" />}
      <span className="streak-medal-label" aria-hidden="true">Серия</span>
      <span className="streak-medal-disc" aria-hidden="true">
        <b>{result.streak}</b>
        <small>подряд</small>
      </span>
      <strong className="streak-medal-bonus" ref={bonusRef} aria-hidden="true">+{number.format(result.bonus)}</strong>
      {!reducedMotion && Array.from({ length: MEDAL_COINS }, (_, i) => {
        const side = i % 2 ? 1 : -1;
        const spread = 40 + ((i * 37) % 120);
        return (
          <i
            key={i}
            className="streak-coin"
            aria-hidden="true"
            style={{
              ["--x" as string]: `${side * spread}px`,
              ["--peak" as string]: `${-90 - ((i * 53) % 70)}px`,
              animationDelay: `${120 + (i % 5) * 30}ms`,
            }}
          />
        );
      })}
    </div>
  );
}

function Flash() {
  const lastResult = useHud((s) => s.lastResult);
  const reducedMotion = usePreferences((s) => s.reducedMotion);
  if (!lastResult || reducedMotion) return null;
  const combo = lastResult.correct && (lastResult.comboUp || lastResult.bonus > 0) ? ` is-combo-${lastResult.bonus > 0 ? "gold" : Math.min(lastResult.multiplier, 5)}` : "";
  return <div className={`screen-flash ${lastResult.correct ? "is-correct" : "is-wrong"}${combo}`} key={lastResult.key} aria-hidden="true" />;
}

function Countdown() {
  const countdown = useHud((s) => s.countdown);
  const startSpeed = useHud((s) => s.startSpeed);
  const phase = useHud((s) => s.phase);
  return <>
    {countdown !== null && <div className="countdown" key={countdown} style={{ animationDuration: `${750 / (countdown > 0 ? startSpeed : 1)}ms` }}>{countdown > 0 ? countdown : "Бежим!"}</div>}
    {(phase === "intro" || phase === "countdown") && <div className="start-hint">{touch ? "Нажми на экран, чтобы ускорить старт" : "Кликай или жми Enter, чтобы ускорить старт"}</div>}
  </>;
}

function KeyHints() {
  const runtime = useRuntime();
  const gateIndex = useHud((s) => s.gateIndex);
  const phase = useHud((s) => s.phase);
  const obstacles = useHud((s) => s.obstacles);
  const hint = useHud((s) => s.hint);
  const enabled = usePreferences((s) => s.keyHints);
  if (!enabled || hint || gateIndex > 2 || (phase !== "running" && phase !== "countdown")) return null;
  if (touch) return (
    <div className="key-hints is-touch">
      <span>Свайп ← → — трек</span>
      {obstacles && <span>↑ прыжок</span>}
      {obstacles && <span>↓ {runtime.night ? "снижение" : "подкат"}</span>}
    </div>
  );
  return (
    <div className="key-hints">
      <span><Kbd>A</Kbd><Kbd>←</Kbd> влево</span>
      <span><Kbd>D</Kbd><Kbd>→</Kbd> вправо</span>
      <span><Kbd>1</Kbd>–<Kbd>4</Kbd> сразу на трек</span>
      {runtime.night && <><span><Kbd>W</Kbd><Kbd>↑</Kbd> разгон</span><span><Kbd>S</Kbd><Kbd>↓</Kbd> до базовой</span></>}
      {obstacles && <span>{runtime.night ? <Kbd>Пробел</Kbd> : <><Kbd>W</Kbd><Kbd>↑</Kbd></>} прыжок</span>}
      {obstacles && <span>{runtime.night ? <Kbd>Shift</Kbd> : <><Kbd>S</Kbd><Kbd>↓</Kbd></>} {runtime.night ? "снижение" : "подкат"}</span>}
      <span><Kbd>Esc</Kbd> пауза</span>
    </div>
  );
}

/** Перед первым барьером и первой балкой — крупная подсказка, что нажать. */
const HINT_TEXT = { jump: "Прыгай!", slide: "Пригнись!", board: "Запрыгни на крышу!", dodge: "Магнитный сбой!", swerve: "Встречный челнок!" } as const;

function MoveHint() {
  const runtime = useRuntime();
  const hint = useHud((s) => s.hint);
  const enabled = usePreferences((s) => s.keyHints);
  // На телефоне всплывающая подсказка закрывает трассу перед самым препятствием.
  if (!hint || !enabled || touch) return null;
  return (
    <div className={`move-hint is-${hint}`} key={hint} role="status">
      {hint === "slide" ? <ArrowDown size={30} strokeWidth={3} aria-hidden="true" /> : hint === "dodge" || hint === "swerve" ? <ArrowLeftRight size={30} strokeWidth={3} aria-hidden="true" /> : <ArrowUp size={30} strokeWidth={3} aria-hidden="true" />}
      <strong>{HINT_TEXT[hint]}</strong>
      <span>
        {runtime.night ? hint === "slide" ? <Kbd>Shift</Kbd> : hint === "dodge" ? <><Kbd>←</Kbd><Kbd>→</Kbd> или <Kbd>Пробел</Kbd></> : hint === "swerve" ? <><Kbd>←</Kbd><Kbd>→</Kbd></> : <Kbd>Пробел</Kbd>
          : hint === "slide" ? <><Kbd>S</Kbd> <Kbd>↓</Kbd></> : <><Kbd>W</Kbd> <Kbd>↑</Kbd> <Kbd>Пробел</Kbd></>}
      </span>
    </div>
  );
}

function Speedometer() {
  const runtime = useRuntime();
  const value = useRef<HTMLOutputElement>(null);
  const bar = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    let frame: number;
    const draw = () => {
      const factor = runtime.speedFactor;
      if (value.current) value.current.textContent = `${factor.toFixed(2).replace(".", ",")}×`;
      if (bar.current) bar.current.style.transform = `scaleX(${(factor - 1) / (MAX_SPEED_FACTOR - 1)})`;
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [runtime]);
  // На телефоне индикатор — педаль: держишь верхнюю половину — разгон, нижнюю — сброс до базы.
  const hold = (accelerating: boolean, braking: boolean) => (event: PointerEvent<HTMLButtonElement>) => {
    runtime.setSpeedInput(accelerating, braking);
    // Захват — чтобы палец, съехавший с кнопки, всё равно отпускал педаль.
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch { /* указатель уже отпущен */ }
  };
  const release = () => runtime.setSpeedInput(false, false);
  const zone = (accelerating: boolean) => (
    <button
      type="button"
      className={`night-speed-zone ${accelerating ? "is-up" : "is-down"}`}
      aria-label={accelerating ? "Разгон" : "До базовой скорости"}
      onPointerDown={hold(accelerating, !accelerating)}
      onPointerUp={release}
      onPointerCancel={release}
      onLostPointerCapture={release}
      onContextMenu={(event) => event.preventDefault()}
    >
      {accelerating ? <ChevronUp size={18} strokeWidth={3} aria-hidden="true" /> : <ChevronDown size={18} strokeWidth={3} aria-hidden="true" />}
    </button>
  );
  return <div className={`night-speedometer ${touch ? "is-touch" : ""}`}>
    {touch && zone(true)}
    <span>МАГНИТНАЯ ТЯГА</span><output ref={value} aria-label="Множитель скорости">1,00×</output>
    <div className="night-speed-track"><span ref={bar} /></div>
    <small>1× база <span>{String(MAX_SPEED_FACTOR).replace(".", ",")}×</span></small>
    {!touch && <p>W / ↑ разгон · S / ↓ до базы</p>}
    {touch && zone(false)}
  </div>;
}

/** Счётчик кадров (включается в параметрах): среднее за полсекунды и видеокарта, на которой рисует браузер. */
function FpsMeter() {
  const output = useRef<HTMLOutputElement>(null);
  const gpu = gpuInfo();
  useEffect(() => {
    let frame = 0;
    let count = 0;
    let start = performance.now();
    const tick = (now: number) => {
      count += 1;
      if (now - start >= 500) {
        const fps = (count * 1000) / (now - start);
        if (output.current) output.current.textContent = `${Math.round(fps)} FPS · ${(1000 / fps).toFixed(1).replace(".", ",")} мс`;
        count = 0;
        start = now;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className={`hud-fps ${gpu.kind === "integrated" || gpu.kind === "software" ? "is-weak" : ""}`}>
      <output ref={output} aria-label="Кадров в секунду">… FPS</output>
      <small>{gpu.name || "видеокарта неизвестна"}</small>
    </div>
  );
}

function PauseMenu({ onRestart, onExit }: { onRestart: () => void; onExit: () => void }) {
  const runtime = useRuntime();
  const phase = useHud((s) => s.phase);
  if (phase !== "paused") return null;
  return (
    <div className="pause-overlay" role="dialog" aria-modal="true" aria-label="Пауза">
      <div className="pause-card">
        <h2>Пауза</h2>
        <button type="button" className="primary-button cta-button" onClick={() => runtime.resume()} autoFocus>
          <Play size={18} fill="currentColor" aria-hidden="true" /> Продолжить
        </button>
        <button type="button" className="secondary-button" onClick={onRestart}>
          <RotateCcw size={16} aria-hidden="true" /> Начать заново
        </button>
        <button type="button" className="secondary-button" onClick={() => runtime.quit()}>
          Закончить и посмотреть ошибки
        </button>
        <button type="button" className="text-button" onClick={onExit}>
          <Close size={16} aria-hidden="true" /> Выйти в меню
        </button>
      </div>
    </div>
  );
}

export function Hud({ onRestart, onExit }: { onRestart: () => void; onExit: () => void }) {
  const runtime = useRuntime();
  const phase = useHud((s) => s.phase);
  const showFps = usePreferences((s) => s.showFps);
  const inRun = phase !== "loading" && phase !== "finished" && phase !== "gameover";

  return (
    <div className="hud">
      <Flash />
      {inRun && (
        <>
          <RouteProgress />
          <ModifierHud />
          <div className="hud-top">
            <ScorePanel />
            <div className="hud-right">
              <Lives />
              <AudioControls />
              <button type="button" className="hud-button" onClick={() => runtime.togglePause()} aria-label="Пауза">
                <Pause size={18} />
              </button>
            </div>
          </div>
        </>
      )}
      {showFps && <FpsMeter />}
      <QuestionBoard />
      <AnswerCards />
      {runtime.night && inRun && <Speedometer />}
      <ComboBanner />
      <Countdown />
      <MistakeToast />
      <KeyHints />
      <MoveHint />
      <PauseMenu onRestart={onRestart} onExit={onExit} />
    </div>
  );
}
