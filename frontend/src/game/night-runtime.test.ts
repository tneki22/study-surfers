import assert from "node:assert/strict";
import test from "node:test";
import { GameRuntime, type NightObstacle } from "./runtime";
import { DEFAULT_SETTINGS } from "./engine/settings";
import type { QuizItem } from "../api/types";
import { useHud } from "./store";
import { laneX } from "./constants";
import { RAMP_LENGTH, RAMP_TOP } from "./engine/obstacles";
import { SHUTTLE_SPEED, SHUTTLE_TRIGGER } from "./engine/night-obstacles";
import type { Pace } from "./engine/settings";

const item: QuizItem = { id: "q1", deck_id: "deck", question_id: null, seq: 1, section: null, prompt: "2+2?", correct: "4", explanation: "", source: "user_docs", enabled: true, edited: false, evidence_quote: null, stats: null, created_at: "", updated_at: "", distractors: [{ text: "3", kind: "far", why_wrong: "" }, { text: "5", kind: "near", why_wrong: "" }, { text: "6", kind: "far", why_wrong: "" }] };
function create(world: "classic" | "night-maglev" = "night-maglev") {
  return new GameRuntime({ settings: { ...DEFAULT_SETTINGS, world, count: "all", pace: "custom", customSeconds: 8, obstacles: false }, items: [item, { ...item, id: "q2" }], live: false, previousBest: null, onComplete: () => {} });
}
function advance(run: GameRuntime, seconds: number, fps = 60) { for (let i = 0; i < Math.round(seconds * fps); i++) run.update(1 / fps); }
function question(run: GameRuntime) { run.start(); for (let i = 0; i < 1000 && !run.gate; i++) run.update(1 / 60); assert.ok(run.gate); }

function hudDanger(run: GameRuntime, distance: number, kind: NightObstacle["kind"] = "energy-wall"): NightObstacle {
  return { id: 990, distance: run.distance + distance, length: 4.2, kind, lane: 0, direction: 1, resolved: false, hit: false, resolvedClock: 0, pattern: "test", variant: 0, beat: 0 };
}

test("ночные карточки открывают опасность на соседней дорожке с 35 м, HUD меняется только на переходах", () => {
  const run = create(); question(run); advance(run, 0.9);
  const row = hudDanger(run, 40);
  assert.notEqual(row.lane, run.targetLane);
  run.nightObstacles.push(row);
  advance(run, 0.25);
  assert.equal(useHud.getState().nightDangerNear, false);
  while (row.distance - run.distance > 35) run.update(1 / 60);
  assert.equal(useHud.getState().nightDangerNear, true);
  let writes = 0;
  const unsubscribe = useHud.subscribe(() => writes++);
  advance(run, 0.5);
  unsubscribe();
  assert.equal(writes, 0, "внутри ближней зоны нет покадровых записей в HUD");
  const next = { ...hudDanger(run, row.distance - run.distance + 10), id: 991 };
  run.nightObstacles.push(next);
  while (!row.resolved) run.update(1 / 60);
  assert.equal(row.hit, false);
  assert.equal(useHud.getState().nightDangerNear, true, "после одного препятствия остаётся следующее");
  while (!next.resolved) run.update(1 / 60);
  assert.equal(useHud.getState().nightDangerNear, false);
});

test("кольца и пройденные опасности не ослабляют карточки; непройденный хвост остаётся видимым", () => {
  const run = create(); question(run);
  const ring = hudDanger(run, 10, "boost-ring");
  const resolved = { ...hudDanger(run, 12), id: 991, resolved: true };
  run.nightObstacles.push(ring, resolved);
  run.update(1 / 60);
  assert.equal(useHud.getState().nightDangerNear, false);
  const tail = { ...hudDanger(run, -1, "repair-arm"), id: 992 };
  run.nightObstacles.push(tail);
  // Под консолями ещё есть непройденный корпус, даже когда их начало уже позади байка.
  advance(run, 0.1);
  assert.equal(tail.resolved, false);
  assert.equal(useHud.getState().nightDangerNear, true);
  while (!tail.resolved) run.update(1 / 60);
  assert.equal(useHud.getState().nightDangerNear, false);
});

test("челнок включает прозрачность по движущемуся корпусу, пауза сохраняет её, новый забег сбрасывает", () => {
  const run = create(); question(run);
  const row = hudDanger(run, 45, "shuttle");
  run.nightObstacles.push(row);
  while (row.distance - run.distance > 35) run.update(1 / 60);
  assert.equal(useHud.getState().nightDangerNear, true);
  assert.ok(row.distance < run.gate!.appearedAt + 45, "учитывается встречное движение челнока");
  run.pause(); advance(run, 2);
  assert.equal(useHud.getState().nightDangerNear, true);
  run.resume();
  while (!row.resolved) run.update(1 / 60);
  assert.equal(useHud.getState().nightDangerNear, false);
  run.nightObstacles.push({ ...hudDanger(run, 10), id: 991 });
  run.update(1 / 60);
  assert.equal(useHud.getState().nightDangerNear, true);
  create();
  assert.equal(useHud.getState().nightDangerNear, false);
  const city = create("classic"); question(city);
  city.nightObstacles.push(hudDanger(city, 10));
  city.update(1 / 60);
  assert.equal(useHud.getState().nightDangerNear, false);
});

test("базовый участок 112 метров занимает 8 секунд, разгон не двигает ворота", () => {
  const run = create(); question(run);
  const at = run.gate!.distance, start = run.clock;
  assert.ok(Math.abs(run.baseSpeed - 14) < 1e-8);
  // Первый вопрос появляется по дистанции участка: опоздание — не больше кадра.
  assert.ok(Math.abs(at - run.gate!.appearedAt - 112) <= 14 / 60 + 1e-8);
  while (run.gate) run.update(1 / 60);
  assert.ok(Math.abs(run.clock - start - 8) <= 2 / 60 + 1e-8);
  const faster = create(); question(faster); const originalGate = faster.gate!; const startClock = faster.clock;
  faster.setSpeedInput(true, false); advance(faster, 2); faster.setSpeedInput(false, false);
  assert.equal(faster.gate!.distance, originalGate.distance);
  assert.ok(Math.abs(faster.speed - 28) < 1e-6);
  while (faster.gate) faster.update(1 / 60);
  assert.ok(faster.clock - startClock < 6);
});

test("ворота взятых наперёд вопросов — через паузу после предыдущих", () => {
  const items = Array.from({ length: 6 }, (_, i) => ({ ...item, id: `q${i}` }));
  const run = new GameRuntime({ settings: { ...DEFAULT_SETTINGS, world: "night-maglev", count: "all", pace: "custom", customSeconds: 12, obstacles: true, lives: 0 }, items, live: false, previousBest: null, onComplete: () => {} });
  question(run);
  const gates: number[] = [];
  while (gates.length < 5 && run.phase === "running") {
    if (run.gate && gates.at(-1) !== run.gate.distance) gates.push(run.gate.distance);
    const near = run.nightObstacles.find(row => !row.resolved && row.distance - run.distance < 20 && row.distance + row.length > run.distance);
    run.setLane(near ? (near.lane + 1) % run.lanes : run.gate?.gate.correctLane ?? run.targetLane);
    run.update(1 / 60);
  }
  // Ворота следующего вопроса — ровно через паузу и участок после текущих.
  for (let i = 1; i < gates.length; i++) assert.ok(Math.abs(gates[i] - gates[i - 1] - 14 * (0.8 + 12)) < 1e-6);
});

function course(world: "classic" | "night-maglev", pace: Pace, customSeconds = 8, count = 18) {
  const items = Array.from({ length: count }, (_, i) => ({ ...item, id: `q${i}` }));
  return new GameRuntime({ settings: { ...DEFAULT_SETTINGS, world, count: "all", pace, customSeconds, obstacles: true, lives: 0 }, items, live: false, previousBest: null, onComplete: () => {} });
}
const rowsOf = (run: GameRuntime) => run.night ? run.nightObstacles : run.obstacles;

/** Едет весь забег всегда в верные ворота, ночью объезжая опасности на своей дорожке. */
function drive(run: GameRuntime, frame: (courseEvent: boolean) => void) {
  let courseEvent = false;
  run.on(event => { if (event.type === "course") courseEvent = true; });
  while (run.phase === "running" || run.phase === "intro" || run.phase === "countdown") {
    const lane = run.gate?.gate.correctLane ?? run.targetLane;
    const near = run.night && run.nightObstacles.find(row => !row.resolved && row.lane === lane && row.distance - run.distance < 30 && row.distance + row.length > run.distance - 2);
    run.setLane(near ? (lane + 1) % run.lanes : lane);
    courseEvent = false;
    run.update(1 / 60);
    frame(courseEvent);
  }
}

test("оба мира, все темпы: препятствия рождаются за видимой далью, и сцена сразу узнаёт о них", () => {
  const cases: ["classic" | "night-maglev", Pace, number][] = [
    ["classic", "normal", 8], ["classic", "fast", 8], ["classic", "calm", 8], ["classic", "custom", 12],
    ["night-maglev", "normal", 8], ["night-maglev", "fast", 8], ["night-maglev", "calm", 8], ["night-maglev", "custom", 12],
  ];
  for (const [world, pace, custom] of cases) {
    const run = course(world, pace, custom);
    run.start();
    // Ряды первых участков стоят с самого начала — ещё до облёта камеры.
    const seen = new Set(rowsOf(run).map(row => row.id));
    assert.ok(seen.size > 0, `${world}/${pace}: трасса пуста на старте`);
    const leads: number[] = [];
    drive(run, courseEvent => {
      for (const row of rowsOf(run)) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        leads.push(row.distance - run.distance);
        assert.ok(courseEvent, `${world}/${pace}: ряд появился без события course`);
      }
    });
    assert.ok(leads.length > 3, `${world}/${pace}: мало рядов (${leads.length})`);
    const nearest = Math.min(...leads);
    assert.ok(nearest > 195, `${world}/${pace}: ближайший ряд родился в ${nearest.toFixed(1)} м`);
  }
});

test("ночью на коротких вопросах быстрого темпа опасности встречаются", () => {
  const run = course("night-maglev", "fast", 8, 16);
  run.start();
  const sections = new Map<number, number>();
  drive(run, () => {
    const gate = run.gate;
    if (!gate) return;
    const count = run.nightObstacles.filter(row => row.distance > gate.appearedAt && row.distance < gate.distance).length;
    sections.set(gate.distance, Math.max(sections.get(gate.distance) ?? 0, count));
  });
  const filled = [...sections.values()].slice(1).filter(count => count > 0).length;
  assert.ok(filled >= 6, `опасности на ${filled} из ${sections.size - 1} участков по 4 с`);
});

test("повтор ошибки приходит через 3–5 вопросов, даже когда трасса взята наперёд", () => {
  for (const world of ["classic", "night-maglev"] as const) {
    const items = Array.from({ length: 12 }, (_, i) => ({ ...item, id: `q${i}`, seq: i + 1 }));
    const run = new GameRuntime({ settings: { ...DEFAULT_SETTINGS, world, count: "all", pace: "custom", customSeconds: 3, obstacles: false, retryMistakes: true }, items, live: false, previousBest: null, onComplete: () => {} });
    run.start();
    const shown: string[] = [];
    while (run.phase !== "finished" && run.phase !== "gameover" && shown.length < 14) {
      if (run.gate && shown.at(-1) !== run.gate.gate.key) shown.push(run.gate.gate.key);
      if (run.gate) run.setLane(shown.length === 1 ? (run.gate.gate.correctLane + 1) % run.lanes : run.gate.gate.correctLane);
      run.update(1 / 60);
    }
    const first = shown[0].split("#")[0];
    const retry = shown.findIndex((key, index) => index > 0 && key.split("#")[0] === first);
    assert.ok(retry - 1 >= 3 && retry - 1 <= 5, `${world}: между ошибкой и повтором ${retry - 1} вопросов`);
  }
});

test("трамплин подбрасывает выше обычного прыжка и приземляет на шпалы", () => {
  const run = create("classic"); question(run);
  const at = run.distance + 2;
  run.obstacles.push({ id: 700, distance: at, lane: run.targetLane, kind: "ramp", length: 20, variant: 0, pattern: "test", beat: 0, resolved: false, met: false, hit: false, resolvedClock: 0 });
  let peak = 0, lands = 0, jumps = 0;
  run.on(event => { if (event.type === "land") lands++; if (event.type === "jump") jumps++; });
  for (let i = 0; i < 120; i++) {
    run.update(1 / 60);
    const along = run.distance - at;
    if (along > 0.5 && along < RAMP_LENGTH - 0.5) assert.ok(Math.abs(run.feet - RAMP_TOP * along / RAMP_LENGTH) < 0.05, "бегун взбегает по подъёму");
    peak = Math.max(peak, run.feet);
  }
  assert.equal(jumps, 1);
  assert.equal(lands, 1);
  assert.ok(peak > 2.6, `пик ${peak.toFixed(2)} м`);
  assert.equal(run.feet, 0);
  assert.equal(run.airborne, false);
});

test("челнок трогается навстречу с гудком, на своей дорожке бьёт, объезд спасает", () => {
  for (const dodge of [false, true]) {
    const run = create(); question(run);
    const lane = run.targetLane;
    const row = { id: 950, distance: run.distance + SHUTTLE_TRIGGER + 6, length: 3.4, kind: "shuttle" as const, lane, direction: 1 as const, resolved: false, hit: false, resolvedClock: 0, pattern: "test", variant: 0, beat: 0 };
    run.nightObstacles.push(row);
    let horns = 0;
    run.on(event => { if (event.type === "shuttle") horns++; });
    advance(run, 0.3);
    assert.equal(horns, 0);
    const parked = row.distance;
    advance(run, 0.6);
    assert.equal(horns, 1);
    assert.ok(row.distance < parked - SHUTTLE_SPEED * 0.3, "челнок едет навстречу");
    if (dodge) run.setLane(lane + 1);
    while (!row.resolved) run.update(1 / 60);
    assert.equal(row.hit, !dodge);
    assert.equal(horns, 1);
  }
});

test("пауза сохраняет множитель и дистанцию, очищает газ; между вопросами — отдельный участок", () => {
  const run = create(); question(run); run.setSpeedInput(true, false); advance(run, 2);
  const factor = run.speedFactor, distance = run.distance;
  run.pause(); advance(run, 10); assert.equal(run.distance, distance); assert.equal(run.speedFactor, factor);
  run.resume(); assert.equal(run.speedControl.accelerating, false);
  while (run.gate) run.update(1 / 60);
  const judgedAt = run.distance;
  while (!run.gate) run.update(1 / 60);
  assert.ok(Math.abs(run.distance - judgedAt - 14 * 0.8) <= run.speed / 60 + 1e-8);
});

test("классический вопрос длится 8 секунд при 8/12/20/60 FPS", () => {
  for (const fps of [8, 12, 20, 60]) {
    const run = create("classic"); question(run);
    let wall = 0;
    while (run.gate) { run.update(1 / fps); wall += 1 / fps; }
    assert.ok(Math.abs(wall - 8) <= 1 / fps + 1e-8, `${fps} FPS: ${wall} секунд`);
  }
});

test("ожидание живой колоды очищает старый вопрос и завершается после endLive", () => {
  const run = new GameRuntime({ settings: { ...DEFAULT_SETTINGS, count: "all", pace: "custom", customSeconds: 3, obstacles: false }, items: [item], live: true, previousBest: null, onComplete: () => {} });
  question(run);
  run.setLane(run.gate!.gate.correctLane);
  while (run.gate) run.update(1 / 60);
  advance(run, 1);
  assert.equal(useHud.getState().waiting, true);
  assert.equal(useHud.getState().gate, null);
  run.endLive(); advance(run, 1);
  assert.equal(run.phase, "finishing");
});

test("разгон в паузе не съедает часть следующего вопроса", () => {
  const run = new GameRuntime({ settings: { ...DEFAULT_SETTINGS, world: "night-maglev", count: "all", pace: "custom", customSeconds: 3, obstacles: false }, items: Array.from({ length: 4 }, (_, i) => ({ ...item, id: `q${i}`, seq: i + 1 })), live: false, previousBest: null, onComplete: () => {} });
  question(run); run.setSpeedInput(true, false);
  let lastKey = "";
  while (run.phase === "running") {
    if (run.gate) {
      if (run.gate.gate.key !== lastKey) {
        lastKey = run.gate.gate.key;
        const span = run.gate.distance - run.gate.appearedAt;
        assert.ok(span >= 42 - run.speed / 60 - 1e-8, `на чтение осталось ${span} м`);
      }
      run.setLane(run.gate.gate.correctLane);
    }
    run.update(1 / 60);
  }
});

test("классический режим игнорирует газ и продолжает ехать с прежней скоростью", () => {
  const run = create("classic"); question(run); run.setSpeedInput(true, false); advance(run, 2);
  assert.equal(run.speedFactor, 1); assert.equal(run.speed, 14);
});

test("красная зона толкает один раз, ввод остаётся доступен и учебные жизни сохраняются", () => {
  const run = create(); question(run); const lane = run.targetLane;
  run.nightObstacles.push({ id: 555, distance: run.distance + 1, length: 4.2, kind: "magnetic-zone", lane, direction: 1, resolved: false, hit: false, resolvedClock: 0, pattern: "test", variant: 0, beat: 0 });
  let hits = 0; run.on(event => { if (event.type === "night-obstacle" && event.hit) hits++; });
  advance(run, 0.15); assert.equal(run.targetLane, lane + 1);
  run.setLane(lane); advance(run, 0.4);
  assert.equal(hits, 1); assert.equal(run.targetLane, lane); assert.equal(useHud.getState().lives, null);
});

test("результаты ночного мира открываются вместе с прибытием в док, а сохранение вызывается один раз", () => {
  let saves = 0;
  const run = new GameRuntime({ settings: { ...DEFAULT_SETTINGS, world: "night-maglev", count: "all", pace: "custom", customSeconds: 3, obstacles: false }, items: [item], live: false, previousBest: null, onComplete: () => { saves++; } });
  question(run);
  run.setLane(run.gate!.gate.correctLane);
  while (run.phase !== "finished") run.update(1 / 60);
  assert.equal(useHud.getState().result?.finished, true);
  assert.equal(saves, 1);
  advance(run, 4);
  assert.equal(saves, 1);
});

test("ночной мир показывает результат потери жизней без ожидания посадки", () => {
  const run = new GameRuntime({ settings: { ...DEFAULT_SETTINGS, world: "night-maglev", lives: 3, count: "all", pace: "custom", customSeconds: 3, obstacles: false }, items: [item, { ...item, id: "q2" }, { ...item, id: "q3" }], live: false, previousBest: null, onComplete: () => {} });
  question(run);
  while (run.phase === "running") {
    if (run.gate) run.setLane((run.gate.gate.correctLane + 1) % run.lanes);
    run.update(1 / 60);
  }
  assert.equal(run.phase, "gameover");
  assert.equal(useHud.getState().result?.finished, false);
});

test("прыжок над магнитной секцией проверяется при 8/30/60/120 FPS без туннелирования", () => {
  for (const fps of [8, 30, 60, 120]) {
    const run = create(); question(run);
    run.speedControl.factor = 1.5; run.speed = 21;
    const row = { id: 900, distance: run.distance + 5, length: 4.2, kind: "magnetic-zone" as const, lane: run.targetLane, direction: 1 as const, resolved: false, hit: false, resolvedClock: 0, pattern: "test", variant: 0, beat: 0 };
    run.nightObstacles.push(row); run.jump(); advance(run, 0.75, fps);
    assert.equal(row.resolved, true); assert.equal(row.hit, false);
  }
});

test("столкновение при перестроении учитывает фактический бок байка на редком кадре", () => {
  const run = create(); question(run);
  const row = { id: 901, distance: run.distance + 1.3, length: 1.6, kind: "repair-bot" as const, lane: 0, direction: 1 as const, resolved: false, hit: false, resolvedClock: 0, pattern: "test", variant: 0, beat: 0 };
  run.nightObstacles.push(row); run.setLane(0); run.update(0.125);
  assert.equal(row.hit, true);
  assert.notEqual(run.runnerX, laneX(0, run.lanes));
});
