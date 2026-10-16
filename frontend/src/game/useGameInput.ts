import { useEffect } from "react";
import { usePreferences } from "../app/stores";
import type { GameRuntime } from "./runtime";
import { SpeedKeys } from "./engine/speed-keys";

/**
 * Клавиатура забега. Смотрим на `event.code`, а не на символ: при русской
 * раскладке A — это «ф», но код клавиши тот же KeyA.
 */
export function useGameInput(runtime: GameRuntime | null) {
  useEffect(() => {
    if (!runtime) return;
    const speedKeys = new SpeedKeys();
    let touchStart: { x: number; y: number; id: number } | null = null;
    const clearTouch = () => { touchStart = null; };
    const clearSpeed = () => { speedKeys.clear(); runtime.setSpeedInput(false, false); };
    const stop = runtime.on(event => {
      if (event.type !== "phase") return;
      if (event.phase !== "running") clearSpeed();
      if (event.phase !== "running" && event.phase !== "finishing") clearTouch();
    });
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.closest("[data-game-controls]") || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable)) return;
      if ((event.code === "Enter" || event.code === "NumpadEnter")
        && !target?.closest("button, a, [role='button']") && runtime.accelerateStart()) {
        event.preventDefault(); return;
      }
      if (runtime.night && speedKeys.change(event.code, true)) {
        if (runtime.phase !== "running") speedKeys.clear();
        runtime.setSpeedInput(speedKeys.accelerating, speedKeys.braking);
        event.preventDefault(); return;
      }
      if (event.repeat) return;
      let handled = true;
      switch (event.code) {
        case "ArrowLeft":
        case "KeyA":
          runtime.moveLane(-1);
          break;
        case "ArrowRight":
        case "KeyD":
          runtime.moveLane(1);
          break;
        case "ArrowUp":
        case "KeyW":
        case "Space":
          runtime.jump();
          break;
        case "ArrowDown":
        case "KeyS":
          runtime.slide();
          break;
        case "ShiftLeft":
        case "ShiftRight":
          if (runtime.night) runtime.slide(); else handled = false;
          break;
        case "Escape":
        case "KeyP":
          runtime.togglePause();
          break;
        case "KeyM": {
          const prefs = usePreferences.getState();
          prefs.update({ musicEnabled: !prefs.musicEnabled });
          break;
        }
        default: {
          const digit = /^(?:Digit|Numpad)([1-4])$/.exec(event.code);
          if (digit) runtime.setLane(Number(digit[1]) - 1);
          else handled = false;
        }
      }
      if (handled) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (runtime.night && speedKeys.change(event.code, false)) runtime.setSpeedInput(speedKeys.accelerating, speedKeys.braking);
    };
    const onPointer = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      if (!target?.closest(".play-screen") || target.closest("[data-game-controls], button, a, input, textarea, select, [contenteditable], [role='button']")) return;
      runtime.accelerateStart();
    };
    // Телефон: свайп влево/вправо — дорожка, вверх — прыжок, вниз — подкат.
    const onTouchStart = (event: TouchEvent) => {
      // В паузе и результатах свайп должен прокручивать интерфейс.
      clearTouch();
      if (runtime.phase !== "running" && runtime.phase !== "finishing") return;
      const touch = event.changedTouches[0];
      const target = event.target instanceof Element ? event.target : null;
      if (!touch || !target?.closest(".play-screen") || target.closest("[data-game-controls], button, a, input, textarea, select, [role='button']")) return;
      touchStart = { x: touch.clientX, y: touch.clientY, id: touch.identifier };
    };
    const onTouchMove = (event: TouchEvent) => { if (touchStart && event.cancelable) event.preventDefault(); };
    const onTouchEnd = (event: TouchEvent) => {
      const touch = touchStart && Array.from(event.changedTouches).find(t => t.identifier === touchStart!.id);
      if (!touchStart || !touch) return;
      const dx = touch.clientX - touchStart.x;
      const dy = touch.clientY - touchStart.y;
      touchStart = null;
      if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
      if (Math.abs(dx) > Math.abs(dy)) runtime.moveLane(dx < 0 ? -1 : 1);
      else if (dy < 0) runtime.jump();
      else runtime.slide();
    };
    // Ушёл из окна — забег встаёт на паузу, а не бежит без игрока.
    const onHide = () => {
      if (document.visibilityState === "hidden") { clearSpeed(); runtime.pause(); }
    };
    const onBlur = () => { clearSpeed(); runtime.pause(); };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("touchstart", onTouchStart, { passive: true });
    window.addEventListener("touchmove", onTouchMove, { passive: false });
    window.addEventListener("touchend", onTouchEnd);
    window.addEventListener("touchcancel", clearTouch);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("touchstart", onTouchStart);
      window.removeEventListener("touchmove", onTouchMove);
      window.removeEventListener("touchend", onTouchEnd);
      window.removeEventListener("touchcancel", clearTouch);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onHide);
      clearSpeed(); stop();
    };
  }, [runtime]);
}
