import { useEffect, useState } from "react";
import { usePreferences } from "../../app/stores";
import { laneX } from "../constants";
import type { GameRuntime } from "../runtime";
import { GameAudio } from "./synth";

const musicLevel = (multiplier: number) => (multiplier >= 3 ? 3 : multiplier >= 2 ? 2 : 1);

/**
 * Звук забега: события рантайма → эффекты, фазы → музыка. Громкости берутся
 * из параметров и меняются на лету. Контекст звука живёт столько же, сколько забег.
 */
export function useGameAudio(runtime: GameRuntime | null): GameAudio | null {
  const [audio, setAudio] = useState<GameAudio | null>(null);

  useEffect(() => {
    if (!runtime || typeof AudioContext === "undefined") return;
    const prefs = usePreferences.getState();
    const sound = new GameAudio(runtime.night, runtime.night ? prefs.nightMusic : prefs.dayMusic);
    setAudio(sound);
    sound.setLevels(usePreferences.getState());
    const stopPrefs = usePreferences.subscribe((prefs) => sound.setLevels(prefs));

    // Браузер мог не дать запустить звук без жеста — запускаем на первом нажатии.
    const unlock = () => sound.resume();
    const onVisibility = () => (document.visibilityState === "hidden" ? sound.suspend() : sound.resume());
    window.addEventListener("keydown", unlock);
    window.addEventListener("pointerdown", unlock);
    document.addEventListener("visibilitychange", onVisibility);

    let paused = false;
    const motion = runtime.night ? setInterval(() => sound.motion(runtime.speed, ["intro", "countdown", "running", "finishing"].includes(runtime.phase),
      runtime.phase === "intro" || Boolean(runtime.gate && runtime.clock - runtime.gate.appearedClock < 1.2)), 80) : undefined;
    const modifierMotion = setInterval(() => sound.modifierMotion(
      runtime.phase === "running" || runtime.phase === "finishing" ? runtime.modifiers.active.find(effect => effect.kind !== "gravity-shoes")?.kind ?? null : null,
      Boolean(runtime.gate && runtime.clock - runtime.gate.appearedClock < 1.2)), 80);
    const stopEvents = runtime.on((event) => {
      switch (event.type) {
        case "modifier": sound.modifier(event.kind, event.action); break;
        case "shield-pulse": sound.shieldPulse(); break;
        case "phase":
          if (event.phase === "paused") {
            paused = true;
            sound.muffle(true);
            break;
          }
          if (paused) {
            paused = false;
            sound.muffle(false);
          }
          if (event.phase === "intro") sound.music.start(0);
          else if (event.phase === "running") sound.music.setLevel(1);
          else if (event.phase === "finished") {
            sound.music.stop(1.4);
            sound.finish();
          } else if (event.phase === "gameover") {
            sound.music.stop(0.6);
            sound.gameover();
          }
          break;
        case "countdown":
          sound.countdown(event.value);
          break;
        case "question":
          sound.question();
          break;
        case "lane":
          sound.lane(event.direction);
          break;
        case "jump":
          if (runtime.night) sound.hoverJump(); else sound.jump();
          break;
        case "land":
          if (runtime.night) sound.hoverLand(); else sound.land(event.impact, event.surface === "deck");
          break;
        case "step":
          sound.step(event.surface === "deck");
          break;
        case "slide":
          if (runtime.night) sound.hoverSlide(); else sound.slide();
          break;
        case "answer":
          if (event.correct) sound.correct(event.multiplier);
          else if (!runtime.night) sound.wrong();
          if (event.milestone) sound.streakMilestone();
          else if (event.comboUp) sound.comboUp(event.multiplier);
          sound.music.setLevel(musicLevel(event.multiplier));
          break;
        case "obstacle":
          if (event.kind === "ramp" || event.kind === "slope") break;
          if (event.hit) sound.bump(event.kind === "handcar" ? "wagons" : event.kind, event.severity ?? "hit");
          else if (event.kind !== "wagons") sound.cleared();
          break;
        case "night-obstacle":
          if (event.hit) { if (event.kind === "magnetic-zone") sound.magneticShift(); else sound.bump(event.kind === "shuttle" ? "wagons" : "bar", event.severity ?? "hit"); }
          else sound.cleared();
          break;
        case "shuttle":
          sound.shuttleHorn(laneX(event.lane, runtime.lanes) / 4);
          break;
        case "handcar":
          sound.handcarBell(laneX(event.lane, runtime.lanes) / 4);
          break;
        case "boost":
          sound.boost();
          break;
        case "coin":
          sound.coin(event.chain);
          break;
      }
    });

    // Забег стартует раньше, чем подписка: музыку интро включаем по текущей фазе.
    if (runtime.phase === "intro" || runtime.phase === "countdown") sound.music.start(0);
    else if (runtime.phase === "running") sound.music.start(1);

    return () => {
      stopEvents();
      clearInterval(motion);
      clearInterval(modifierMotion);
      stopPrefs();
      window.removeEventListener("keydown", unlock);
      window.removeEventListener("pointerdown", unlock);
      document.removeEventListener("visibilitychange", onVisibility);
      sound.dispose();
      setAudio(null);
    };
  }, [runtime]);

  return audio;
}
