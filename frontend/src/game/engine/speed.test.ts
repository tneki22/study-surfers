import assert from "node:assert/strict";
import test from "node:test";
import { advanceSpeed, MAX_SPEED_FACTOR, SpeedControl } from "./speed";
import { SpeedKeys } from "./speed-keys";

test("разгон до 2,25× за 2,5 секунды, торможение за 1,25, фиксация и границы", () => {
  assert.equal(MAX_SPEED_FACTOR, 2.25);
  for (const fps of [30, 60, 120]) {
    const speed = new SpeedControl();
    speed.accelerating = true;
    for (let i = 0; i < fps * 2.5; i++) speed.update(1 / fps);
    assert.ok(Math.abs(speed.factor - MAX_SPEED_FACTOR) < 1e-10);
    speed.clear(); speed.update(10); assert.ok(Math.abs(speed.factor - MAX_SPEED_FACTOR) < 1e-10);
    speed.accelerating = true; speed.braking = true;
    for (let i = 0; i < fps * 1.25; i++) speed.update(1 / fps);
    assert.ok(Math.abs(speed.factor - 1) < 1e-10);
    speed.update(10); assert.equal(speed.factor, 1);
  }
});

test("интегрирование расстояния при разгоне и ограничении совпадает на разных FPS", () => {
  for (const fps of [20, 30, 60, 120]) {
    let speed = 14, distance = 0;
    for (let i = 0; i < fps * 3; i++) {
      const next = advanceSpeed(speed, 21, 3.5, 1 / fps); speed = next.speed; distance += next.distance;
    }
    assert.ok(Math.abs(distance - 56) < 1e-8, `${fps}: ${distance}`);
    assert.equal(speed, 21);
  }
});

test("дублёры, повторные keydown и очистка удержаний", () => {
  const keys = new SpeedKeys();
  keys.change("KeyW", true); keys.change("KeyW", true); keys.change("ArrowUp", true);
  keys.change("KeyW", false); assert.equal(keys.accelerating, true);
  keys.change("ArrowUp", false); assert.equal(keys.accelerating, false);
  keys.change("KeyS", true); keys.change("ArrowDown", true); keys.change("KeyS", false);
  assert.equal(keys.braking, true);
  keys.clear(); assert.equal(keys.braking, false); assert.equal(keys.accelerating, false);
  assert.equal(keys.change("Space", true), false);
});
