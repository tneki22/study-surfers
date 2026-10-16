import assert from "node:assert/strict";
import test from "node:test";
import { modifierBudget, ModifierPlanner, ModifierState, modifierTarget, PICKUP_CLEAR_SECONDS } from "./modifiers";
import { createRng } from "./random";

test("модификаторы: бюджет N/5…2N/5, равномерные участки, набор без повторов", () => {
  for (const world of ["classic", "night-maglev"] as const) for (const mainTotal of [10, 20, 30]) for (let seed = 0; seed < 40; seed++) {
    const planner = new ModifierPlanner(world, createRng(seed));
    const found = [];
    for (let index = 1; index <= mainTotal; index++) {
      const input = { mainTotal, retry: false, start: index * 200, end: index * 200 + 160, maxSpeed: 34, lanes: 4, hazards: [] };
      assert.equal(planner.section({ ...input, retry: true }), null, "повтор не расходует бюджет и участок");
      const pickup = planner.section(input);
      if (pickup) found.push({ ...pickup, index });
    }
    const budget = planner.budget(mainTotal);
    assert.ok(budget >= mainTotal / 5 && budget <= (mainTotal * 2) / 5, `бюджет ${budget} для ${mainTotal}`);
    assert.equal(found.length, budget);
    assert.deepEqual(found.map(p => p.index), Array.from({ length: budget }, (_, i) => modifierTarget(i, mainTotal, budget)));
    assert.equal(found[0].index, 2);
    assert.ok(found.at(-1)!.index <= mainTotal * 0.8, "последние 20% без предметов");
    const bagSize = world === "classic" ? 2 : 3;
    for (let i = 0; i < found.length; i += bagSize) assert.equal(new Set(found.slice(i, i + bagSize).map(p => p.kind)).size, Math.min(bagSize, found.length - i));
  }
});

test("модификаторы: на 10 вопросов выпадает 2, 3 или 4 предмета", () => {
  const counts = new Map<number, number>();
  for (let seed = 0; seed < 400; seed++) {
    const budget = new ModifierPlanner("classic", createRng(seed)).budget(10);
    counts.set(budget, (counts.get(budget) ?? 0) + 1);
  }
  assert.deepEqual([...counts.keys()].sort(), [2, 3, 4]);
  assert.equal(modifierBudget(10, 0), 2);
  assert.equal(modifierBudget(10, 0.99), 4);
  assert.equal(modifierBudget(40, 0.5), 12);
});

test("модификаторы: безопасный зазор, длина опасностей и перенос тесного участка", () => {
  for (let seed = 0; seed < 100; seed++) {
    const planner = new ModifierPlanner("night-maglev", createRng(seed));
    const hazards = [0, 1, 2, 3].map(lane => ({ lane, from: 55, to: 90 }));
    const input = { mainTotal: 10, retry: false, start: 0, end: 200, maxSpeed: 40, lanes: 4, hazards };
    planner.section(input);
    const pickup = planner.section(input)!;
    const margin = 40 * PICKUP_CLEAR_SECONDS;
    assert.ok(pickup.distance >= margin && pickup.distance <= 200 - margin);
    assert.ok(pickup.distance <= 55 - margin || pickup.distance >= 90 + margin);
  }
  const planner = new ModifierPlanner("classic", createRng(1));
  const input = { mainTotal: 10, retry: false, start: 0, end: 10, maxSpeed: 20, lanes: 3, hazards: [] };
  planner.section(input);
  assert.equal(planner.section(input), null);
  assert.equal(planner.placed, 0);
  assert.ok(planner.section({ ...input, end: 100 }));
});

test("таймеры: замена слотов, обновление, три импульса, совместимость магнита", () => {
  const state = new ModifierState();
  state.activate("jetpack", 0);
  state.activate("gravity-shoes", 2);
  assert.equal(state.has("jetpack"), false);
  assert.equal(state.expire(7).length, 0);
  assert.equal(state.expire(8)[0].kind, "gravity-shoes");
  state.activate("shield", 10);
  state.activate("magnet", 10);
  assert.equal(state.pulse(), 2);
  state.activate("shield", 12);
  assert.equal(state.pulse(), 2);
  assert.equal(state.pulse(), 1);
  assert.equal(state.pulse(), 0);
  assert.equal(state.has("shield"), false);
  assert.equal(state.has("magnet"), true);
  state.activate("shield", 13);
  state.activate("phase", 14);
  assert.equal(state.has("shield"), false);
  assert.equal(state.has("phase"), true);
  assert.equal(state.has("magnet"), true);
});

test("спавн: после 80% нет переноса, тесный участок не расходует вид и бюджет", () => {
  const blocked = new ModifierPlanner("night-maglev", () => 0.5);
  const clear = new ModifierPlanner("night-maglev", () => 0.5);
  const input = { mainTotal: 10, retry: false, start: 0, end: 200, maxSpeed: 31.5, lanes: 4, hazards: [] };
  clear.section(input); blocked.section(input);
  assert.equal(blocked.section({ ...input, end: 1 }), null);
  assert.equal(blocked.placed, 0);
  assert.equal(blocked.section(input)?.kind, clear.section(input)?.kind);
  const noRoom = new ModifierPlanner("classic", createRng(9));
  for (let i = 0; i < 8; i++) assert.equal(noRoom.section({ ...input, end: 1 }), null);
  assert.equal(noRoom.section(input), null, "девятый участок уже входит в последние 20%");
});
