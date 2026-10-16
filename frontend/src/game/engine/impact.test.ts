import assert from "node:assert/strict";
import test from "node:test";
import { laneX } from "../constants";
import { escalate, IMPACTS, Slowdown } from "./impact";
import { nightImpact } from "./night-obstacles";
import { cityImpact, DECK_HEIGHT, HURDLE_CLEARANCE, STEP_UP } from "./obstacles";

test("сила столкновения: чем сильнее, тем больше штраф и потеря скорости", () => {
  assert.ok(IMPACTS.graze.penalty < IMPACTS.hit.penalty && IMPACTS.hit.penalty < IMPACTS.crash.penalty);
  assert.ok(IMPACTS.graze.drop < IMPACTS.hit.drop && IMPACTS.hit.drop < IMPACTS.crash.drop);
  assert.equal(escalate("graze"), "hit");
  assert.equal(escalate("hit"), "crash");
  assert.equal(escalate("crash"), "crash");
});

test("город: чуть низкий прыжок и неполный подкат — задел, без действия — удар", () => {
  assert.equal(cityImpact("hurdle", HURDLE_CLEARANCE + 0.01, 0), null);
  assert.equal(cityImpact("hurdle", HURDLE_CLEARANCE - 0.05, 0), "graze");
  assert.equal(cityImpact("hurdle", 0, 0), "hit");
  assert.equal(cityImpact("bar", 0, 1), null);
  assert.equal(cityImpact("bar", 0, 0.8), "graze");
  assert.equal(cityImpact("bar", 0, 0), "hit");
  assert.equal(cityImpact("wagons", DECK_HEIGHT - STEP_UP - 0.1, 0), "graze");
  assert.equal(cityImpact("wagons", 0, 0), "hit");
  assert.equal(cityImpact("ramp", 0, 0), null);
});

test("ночь: челнок — крушение, магнит — задел, краем корпуса — задел", () => {
  assert.equal(nightImpact("shuttle", 1, 3, 0, 0, 0), "crash");
  assert.equal(nightImpact("magnetic-zone", 1, 3, 0, 0, 0), "graze");
  assert.equal(nightImpact("repair-bot", 1, 3, laneX(1, 3), 0, 0), "hit");
  assert.equal(nightImpact("repair-bot", 1, 3, laneX(1, 3), 0.7, 0), "graze");
  assert.equal(nightImpact("repair-bot", 1, 3, laneX(1, 3) + 1.5, 0, 0), "graze");
  assert.equal(nightImpact("repair-arm", 1, 3, laneX(1, 3), 0, 0), "hit");
});

/** Сколько метров пройдено за `seconds` с замедлением после столкновения в момент 0. */
function ride(severity: keyof typeof IMPACTS, seconds: number, base = 14) {
  const slowdown = new Slowdown();
  slowdown.hit(0, IMPACTS[severity]);
  let distance = 0;
  const dt = 1 / 120;
  let lowest = 1;
  for (let t = 0; t < seconds; t += dt) {
    const factor = slowdown.step(t, dt, base);
    lowest = Math.min(lowest, factor);
    distance += base * factor * dt;
  }
  return { distance, lowest, lag: slowdown.lag };
}

test("замедление: скорость падает сразу, а потерянные метры бегун догоняет", () => {
  for (const severity of ["graze", "hit", "crash"] as const) {
    const early = ride(severity, IMPACTS[severity].recover);
    assert.ok(Math.abs(early.lowest - (1 - IMPACTS[severity].drop)) < 0.02, `${severity}: сразу ${early.lowest}`);
    assert.ok(early.lag > 0.5, `${severity}: отставание ${early.lag}`);
    // Через несколько секунд отставание возвращено: время до ворот не изменилось.
    const later = ride(severity, IMPACTS[severity].recover + 5);
    assert.ok(later.lag < 1e-6, `${severity}: не догнал ${later.lag}`);
    assert.ok(Math.abs(later.distance - 14 * (IMPACTS[severity].recover + 5)) < 0.3, `${severity}: ${later.distance}`);
  }
});

test("второе столкновение во время замедления не возвращает скорость", () => {
  const slowdown = new Slowdown();
  slowdown.hit(0, IMPACTS.hit);
  const before = slowdown.factor(0.2);
  slowdown.hit(0.2, IMPACTS.graze);
  assert.ok(slowdown.factor(0.2) < before);
});
