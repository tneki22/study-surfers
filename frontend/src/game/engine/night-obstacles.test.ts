import assert from "node:assert/strict";
import test from "node:test";
import {
  crossingShare,
  forcedLane,
  nightClearDistance,
  nightReach,
  nightWindow,
  planNightObstacles,
  shuttleMeetOffset,
  SHUTTLE_TOP,
  touchesNightObstacle,
} from "./night-obstacles";
import { createRng } from "./random";
import { MAX_SPEED_FACTOR } from "./speed";

const BASE = 14;
const plan = (seed: number, seconds: number, gateIndex: number, placed: number, lanes = 3, start = 0, more = false) =>
  planNightObstacles(createRng(seed), { start, end: start + BASE * seconds, baseSpeed: BASE, lanes, gateIndex, placed, more }).rows;

test("первый вопрос и слишком короткий участок — без опасностей", () => {
  for (const seconds of [3, 4, 5, 8, 12, 20]) assert.deepEqual(plan(1, seconds, 1, 0), []);
  for (let seed = 0; seed < 200; seed++) assert.deepEqual(plan(seed, 3, 5, 4), []);
});

test("короткие вопросы обычного и быстрого темпа тоже получают опасности", () => {
  for (const seconds of [4, 5, 6, 7, 8]) {
    let filled = 0;
    for (let seed = 0; seed < 400; seed++) if (plan(seed, seconds, 3 + (seed % 5), 3 + (seed % 7)).length) filled++;
    // 20% участков намеренно пустые — ритм забега; остальные должны получить ряд.
    assert.ok(filled / 400 > 0.7, `${seconds} с: опасности на ${filled} из 400`);
  }
  // Знакомство идёт с первого же короткого участка после вопроса без опасностей.
  assert.equal(plan(1, 4, 2, 0)[0]?.kind, "repair-bot");
});

test("свободный путь у ворот растёт с участком: от 1,3 до 3 секунд на базе", () => {
  assert.equal(nightClearDistance(BASE, 4), BASE * 1.3);
  assert.equal(nightClearDistance(BASE, 8), BASE * 2.4);
  assert.equal(nightClearDistance(BASE, 12), BASE * 3);
  assert.equal(nightClearDistance(BASE, 20), BASE * 3);
});

test("3000 вариантов: чтение после паузы, свободный путь у ворот, в каждом ряду есть путь", () => {
  const kinds = new Set<string>();
  const dodge = new Set(["magnetic-zone", "shuttle", "energy-wall"]);
  for (let seed = 0; seed < 3000; seed++) {
    const lanes = seed % 2 ? 3 : 4, start = 420, seconds = 4 + (seed % 17), end = start + BASE * seconds;
    const rows = plan(seed, seconds, 2 + (seed % 10), seed % 12, lanes, start, seed % 3 === 0);
    const window = nightWindow({ start, end, baseSpeed: BASE });
    // Пауза 0,8 с на 1,5× съедает 5,6 м участка, потом 0,6 с чтения на 21 м/с.
    assert.ok(Math.abs(window.from - (start + 21 * 1.4 - 14 * 0.8)) < 1e-9);
    for (const row of rows) {
      kinds.add(row.kind);
      assert.ok(row.distance - nightReach(row.kind, BASE) >= window.from - 1e-8, `seed ${seed}: слишком рано`);
      // Челнок: встреча на любой скорости — до восстановления перед свободным путём у ворот.
      const last = row.kind === "shuttle" ? row.distance - shuttleMeetOffset(BASE * MAX_SPEED_FACTOR) + row.length : row.distance + row.length;
      assert.ok(last + 21 * 0.65 <= end - nightClearDistance(BASE, seconds) + 1e-8, `seed ${seed}: ${row.kind} залезает в окно ворот`);
      assert.ok(row.lane >= 0 && row.lane < lanes);
      if (row.kind === "magnetic-zone") assert.ok(row.lane + row.direction >= 0 && row.lane + row.direction < lanes);
      // Путь есть: в окрестности ряда не все дорожки требуют объезда, и у объезда есть соседняя дорожка без объезда.
      if (dodge.has(row.kind)) {
        const at = row.kind === "shuttle" ? row.distance - shuttleMeetOffset(BASE) : row.distance;
        const blocked = (lane: number) => rows.some((other) => other !== row && other.lane === lane && dodge.has(other.kind)
          && Math.abs((other.kind === "shuttle" ? other.distance - shuttleMeetOffset(BASE) : other.distance) - at) < 6);
        const exits = [row.lane - 1, row.lane + 1].filter((lane) => lane >= 0 && lane < lanes && !blocked(lane));
        assert.ok(exits.length > 0, `seed ${seed}: от ${row.kind} на дорожке ${row.lane} некуда уйти`);
      }
    }
    // На дорожке челнока между встречей и стоянкой ничего нет: он едет сквозь.
    for (const shuttle of rows.filter((row) => row.kind === "shuttle")) {
      for (const row of rows) {
        if (row === shuttle || row.lane !== shuttle.lane) continue;
        assert.ok(row.distance + row.length <= shuttle.distance - shuttleMeetOffset(BASE) - 2 || row.distance >= shuttle.distance + shuttle.length + 2, `seed ${seed}: на пути челнока ${row.kind}`);
      }
    }
  }
  assert.deepEqual([...kinds].sort(), ["energy-wall", "magnetic-zone", "repair-arm", "repair-bot", "shuttle"]);
});

test("ночные паттерны: все встречаются, испытания — только в режиме «Больше»", () => {
  const seen = new Set<string>();
  for (let seed = 0; seed < 3000; seed++) {
    const more = seed % 2 === 0;
    for (const row of plan(seed, 6 + (seed % 9), 9, 9, 3 + (seed % 3 === 0 ? 1 : 0), 0, more)) seen.add(`${more}:${row.pattern}`);
  }
  for (const name of ["single", "pair", "edge-magnet", "gate", "oncoming", "slalom", "magnet-trap", "barrier"]) assert.ok(seen.has(`false:${name}`), name);
  for (const name of ["double-shuttle", "gate-slalom"]) {
    assert.ok(seen.has(`true:${name}`), name);
    assert.ok(!seen.has(`false:${name}`), `${name} в обычном режиме`);
  }
});

test("плотность ночью: обычный режим втрое гуще прежнего, «Больше» — ещё гуще; челнок и на коротких вопросах", () => {
  const own = (seconds: number, more: boolean) => {
    let count = 0, shuttles = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const rows = plan(seed, seconds, 9, 9, 3, 0, more);
      count += rows.filter((row) => row.lane === 1).length;
      shuttles += rows.filter((row) => row.kind === "shuttle").length;
    }
    return { own: count / 1500, shuttles: shuttles / 1500 };
  };
  for (const seconds of [6, 8, 10]) {
    const normal = own(seconds, false), more = own(seconds, true);
    // Было: ≈0,27 опасности на своей дорожке за вопрос.
    assert.ok(normal.own >= 0.5, `${seconds} с: на своей дорожке ${normal.own}`);
    // «Больше» ограничено безопасным шагом между действиями на полном газу (см. NIGHT_STEP_SECONDS).
    assert.ok(more.own / normal.own >= 1.15, `${seconds} с: «больше» ${more.own} против ${normal.own}`);
    assert.ok(normal.shuttles > 0.03, `${seconds} с: челноков ${normal.shuttles}`);
  }
});

test("челнок встречает байк в пределах участка на любой скорости от базы до максимума", () => {
  for (let factor = 1; factor <= MAX_SPEED_FACTOR + 1e-9; factor += 0.05) {
    const offset = shuttleMeetOffset(BASE * factor);
    assert.ok(offset > 0 && offset <= nightReach("shuttle", BASE) + 1e-9);
  }
  // Медленнее базы байк не едет — значит, встреча не раньше учтённой в бюджете.
  assert.ok(shuttleMeetOffset(BASE) > shuttleMeetOffset(BASE * MAX_SPEED_FACTOR));
});

test("физический объём учитывает перестроение, прыжок и снижение", () => {
  assert.equal(touchesNightObstacle("repair-bot", 1, 3, 0, 0, 0), true);
  assert.equal(touchesNightObstacle("repair-bot", 1, 3, 1.4, 0, 0), true);
  assert.equal(touchesNightObstacle("repair-bot", 1, 3, 2.6, 0, 0), false);
  assert.equal(touchesNightObstacle("repair-bot", 1, 3, 0, 0.8, 0), false);
  assert.equal(touchesNightObstacle("repair-arm", 1, 3, 0, 0, 1), false);
  assert.equal(touchesNightObstacle("repair-arm", 1, 3, 0, 1, 1), true);
  assert.equal(touchesNightObstacle("magnetic-zone", 1, 3, 0, 0.4, 0), false);
  // Челнок не перепрыгнуть и не проползти под ним: только объезд.
  assert.equal(touchesNightObstacle("shuttle", 1, 3, 0, 1.2, 0), true);
  assert.equal(touchesNightObstacle("shuttle", 1, 3, 0, 0, 1), true);
  assert.equal(touchesNightObstacle("shuttle", 1, 3, 2.6, 0, 0), false);
  assert.ok(SHUTTLE_TOP > 1.2);
  assert.equal(crossingShare(10, 12, 11), 0.5);
  assert.equal(forcedLane(0, -1, 3), 0);
  assert.equal(forcedLane(3, 1, 4), 3);
  // Энергобарьер — только объезд, кольцо не задевает.
  assert.equal(touchesNightObstacle("energy-wall", 1, 3, 0, 1.2, 0), true);
  assert.equal(touchesNightObstacle("energy-wall", 1, 3, 0, 0, 1), true);
  assert.equal(touchesNightObstacle("energy-wall", 1, 3, 2.6, 0, 0), false);
  assert.equal(touchesNightObstacle("boost-ring", 1, 3, 0, 0, 0), false);
});
