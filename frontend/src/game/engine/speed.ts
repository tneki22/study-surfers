/** Управление скоростью ховербайка. Множитель хранится после отпускания клавиш. */
export const MAX_SPEED_FACTOR = 2.25;
/** Рост множителя в секунду: от базы до максимума — 2,5 секунды. */
export const ACCELERATION = 0.5;
/** Торможение с максимума до базы — 1,25 секунды. */
export const BRAKING = 1;

export class SpeedControl {
  factor = 1;
  accelerating = false;
  braking = false;
  clear() { this.accelerating = false; this.braking = false; }
  update(dt: number): number {
    const rate = this.braking ? -BRAKING : this.accelerating ? ACCELERATION : 0;
    this.factor = Math.max(1, Math.min(MAX_SPEED_FACTOR, this.factor + rate * dt));
    return this.factor;
  }
}

/** Точное интегрирование линейного разгона с ограничителем, без зависимости от FPS. */
export function advanceSpeed(speed: number, target: number, rate: number, dt: number): { speed: number; distance: number } {
  const duration = rate > 0 ? Math.min(dt, Math.abs(target - speed) / rate) : 0;
  const next = rate > 0 ? speed + Math.sign(target - speed) * rate * duration : speed;
  return { speed: next, distance: (speed + next) * duration / 2 + next * (dt - duration) };
}
