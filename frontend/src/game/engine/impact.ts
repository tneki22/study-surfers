/**
 * Сила столкновения. Как в оригинале, даже зацеп замедляет: задел — лёгкое
 * спотыкание, удар — заметная потеря скорости, крушение — почти остановка.
 * Очки снимаются через addPoints (комбо и жизни не трогаются).
 */
export type Severity = "graze" | "hit" | "crash";

export interface Impact {
  /** Сколько очков снять. */
  penalty: number;
  /** Доля скорости, теряемая сразу. */
  drop: number;
  /** За сколько секунд скорость возвращается. */
  recover: number;
  /** Амплитуда тряски камеры. */
  shake: number;
}

export const IMPACTS: Record<Severity, Impact> = {
  graze: { penalty: 10, drop: 0.25, recover: 0.5, shake: 0.06 },
  hit: { penalty: 30, drop: 0.5, recover: 1, shake: 0.12 },
  crash: { penalty: 60, drop: 0.8, recover: 1.5, shake: 0.2 },
};

/** «На хвосте»: столько секунд после столкновения следующее считается на ступень сильнее. */
export const CHASE_SECONDS = 4;
/** Насколько быстрее расписания бегун догоняет потерянные метры после восстановления. */
export const CATCH_UP = 0.3;
/** Запас, в котором промах — ещё «задел», а не удар: по высоте ступней, м. */
export const GRAZE_MARGIN = 0.15;

export function escalate(severity: Severity): Severity {
  return severity === "graze" ? "hit" : "crash";
}

/**
 * Замедление после столкновения и догон. Скорость сразу падает на `drop`,
 * за `recover` секунд линейно возвращается, затем бегун идёт на CATCH_UP быстрее,
 * пока не вернёт отставание `lag`: время до ворот от столкновения не растёт,
 * и врезаться ради лишней секунды на раздумье невыгодно.
 */
export class Slowdown {
  private started = Number.NEGATIVE_INFINITY;
  private drop = 0;
  private recover = 1;
  /** Отставание от расписания, м. */
  lag = 0;

  hit(clock: number, impact: Impact) {
    // Новое столкновение во время замедления не делает скорость выше текущей.
    const now = 1 - this.slowing(clock);
    this.started = clock;
    this.drop = Math.min(0.9, 1 - now * (1 - impact.drop));
    this.recover = impact.recover;
  }

  /** Насколько скорость сейчас ниже расписания, 0…1. */
  private slowing(clock: number): number {
    const t = (clock - this.started) / this.recover;
    return t >= 0 && t < 1 ? this.drop * (1 - t) : 0;
  }

  /** Множитель скорости в момент `clock`. */
  factor(clock: number): number {
    const slowing = this.slowing(clock);
    if (slowing > 0) return 1 - slowing;
    return this.lag > 1e-6 ? 1 + CATCH_UP : 1;
  }

  /** Кадр: множитель скорости и учёт отставания; `base` — скорость по расписанию (0 — без догона). */
  step(clock: number, dt: number, base: number): number {
    const factor = this.factor(clock);
    this.lag = Math.max(0, this.lag + (1 - factor) * base * dt);
    return factor;
  }

  active(clock: number): boolean {
    return this.slowing(clock) > 0 || this.lag > 1e-6;
  }
}
