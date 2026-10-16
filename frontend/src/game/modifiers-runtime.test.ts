import assert from "node:assert/strict";
import test from "node:test";
import type { QuizItem } from "../api/types";
import { DEFAULT_SETTINGS, type SessionSettings } from "./engine/settings";
import { GameRuntime, type NightObstacle } from "./runtime";
import { BAR_TOPS, cityImpact, DECK_HEIGHT } from "./engine/obstacles";
import type { NightObstacleKind } from "./engine/night-obstacles";
import { laneX } from "./constants";
import { useHud } from "./store";
import { modifierTarget } from "./engine/modifiers";

const item: QuizItem = { id: "q", deck_id: "deck", question_id: null, seq: 1, section: null, prompt: "2+2?", correct: "4", explanation: "", source: "user_docs", enabled: true, edited: false, evidence_quote: null, stats: null, created_at: "", updated_at: "", distractors: [{ text: "3", kind: "far", why_wrong: "" }, { text: "5", kind: "near", why_wrong: "" }, { text: "6", kind: "far", why_wrong: "" }] };
function run(settings: Partial<SessionSettings> = {}, count = 20, live = false) {
  const runtime = new GameRuntime({ settings: { ...DEFAULT_SETTINGS, obstacles: false, count: "all", pace: "custom", customSeconds: 5, ...settings }, items: Array.from({ length: count }, (_, i) => ({ ...item, id: `q${i}`, seq: i })), live, previousBest: null, seed: 79, onComplete() {} });
  runtime.start();
  return runtime;
}
function advance(runtime: GameRuntime, seconds: number, fps = 60) { for (let i = 0; i < Math.round(seconds * fps); i++) runtime.update(1 / fps); }
function ready(settings: Partial<SessionSettings> = {}) { const r = run(settings); while (!r.gate) r.update(1 / 60); return r; }

test("рантайм: модификаторы независимы от препятствий и не меняют случайность трассы", () => {
  for (const world of ["classic", "night-maglev"] as const) for (const obstacles of [false, true]) {
    const enabled = run({ world, obstacles, modifiers: true });
    const disabled = run({ world, obstacles, modifiers: false });
    assert.equal(enabled.modifierPlanner.placed, 2, "участки 2 и следующий целевой уже за горизонтом подготовки");
    assert.equal(disabled.pickups.length, 0);
    assert.deepEqual(enabled.obstacles, disabled.obstacles);
    assert.deepEqual(enabled.nightObstacles, disabled.nightObstacles);
    const questions: string[][] = [[], []];
    [enabled, disabled].forEach((r, i) => r.on(e => { if (e.type === "question") questions[i].push(JSON.stringify(e.gate)); }));
    advance(enabled, 100);
    advance(disabled, 100);
    assert.deepEqual(questions[0], questions[1]);
    const planner = enabled.modifierPlanner;
    const budget = planner.budget(20);
    const due = Array.from({ length: budget }, (_, i) => modifierTarget(i, 20, budget)).filter(index => index <= planner.mainIndex);
    assert.equal(planner.placed, due.length);
  }
});

test("рантайм: подбор на любой высоте, пауза, обновление и выключенный тумблер", () => {
  const r = ready();
  r.pickups.push({ id: 999, kind: "jetpack", distance: r.distance + 1, lane: r.targetLane, resolved: false, taken: false, takenClock: -10 });
  r.feet = 3; r.airborne = true;
  advance(r, 0.1);
  assert.equal(r.modifiers.has("jetpack"), true);
  r.pause();
  const expiresAt = r.modifiers.active[0].expiresAt;
  advance(r, 30);
  assert.equal(r.modifiers.active[0].expiresAt, expiresAt);
  r.resume();
  advance(r, 5.5);
  assert.equal(r.modifiers.has("jetpack"), true);
  r.activateModifier("jetpack");
  advance(r, 5.5);
  assert.equal(r.modifiers.has("jetpack"), true);
  advance(r, 0.6);
  assert.equal(r.modifiers.has("jetpack"), false);
  const off = ready({ modifiers: false });
  off.activateModifier("jetpack");
  assert.equal(off.modifiers.active.length, 0);
});

test("джетпак: 2,6 м, управление крайними треками, ответы над воротами и плавная посадка", () => {
  for (const lanes of [3, 4] as const) for (const fps of [15, 30, 120]) {
    const r = ready({ lanes });
    r.activateModifier("jetpack");
    advance(r, 0.8, fps);
    assert.equal(r.feet, 2.6);
    r.jump(); r.slide();
    advance(r, 0.1, fps);
    assert.equal(r.feet, 2.6);
    assert.equal(r.slideProgress(), -1);
    r.setLane(0); advance(r, 0.5, fps);
    assert.ok(Math.abs(r.runnerX + (lanes - 1) * 1.3) < 0.03);
    r.setLane(lanes - 1); advance(r, 0.5, fps);
    assert.ok(Math.abs(r.runnerX - (lanes - 1) * 1.3) < 0.03);
    r.setLane(r.gate!.gate.correctLane);
    r.gate!.distance = r.distance + 4;
    let correct: boolean | null = null;
    r.on(e => { if (e.type === "answer") correct = e.correct; });
    advance(r, 0.4, fps);
    assert.equal(correct, true);
    assert.equal(r.modifiers.has("jetpack"), true, "ворота не отменяют полёт");
    advance(r, 3.8, fps);
    assert.ok(r.feet > 0, "нет мгновенного падения при истечении");
    advance(r, 1.2, fps);
    assert.equal(r.feet, 0);
    assert.equal(r.airborne, false);
  }
});

test("джетпак: безопасная посадка над вагоном; гравикроссы завершают начатый прыжок", () => {
  const r = ready();
  r.activateModifier("jetpack");
  advance(r, 5.7);
  r.obstacles.push({ id: 900, kind: "wagons", lane: r.targetLane, distance: r.distance - 2, length: 40, variant: 0, pattern: "test", beat: 0, resolved: false, met: false, hit: false, resolvedClock: 0 });
  let hits = 0;
  r.on(e => { if (e.type === "obstacle" && e.hit) hits++; });
  advance(r, 1.3);
  assert.equal(r.feet, DECK_HEIGHT);
  assert.equal(hits, 0);
  const shoes = ready();
  shoes.activateModifier("gravity-shoes");
  advance(shoes, 5.8);
  shoes.jump();
  let peak = 0;
  for (let i = 0; i < 90; i++) { shoes.update(1 / 120); peak = Math.max(peak, shoes.feet); }
  assert.equal(shoes.modifiers.has("gravity-shoes"), false);
  assert.ok(peak > 2.5 && peak <= 2.6);
  advance(shoes, 0.6);
  assert.equal(shoes.feet, 0);
  for (let variant = 0; variant < BAR_TOPS.length; variant++) {
    assert.equal(cityImpact("bar", 2.6, 0, variant), null);
    assert.ok(cityImpact("bar", BAR_TOPS[variant] - 0.01, 0, variant));
  }
});

function danger(r: GameRuntime, id: number, kind: NightObstacleKind, offset: number, lane = r.targetLane, length = 3) {
  const row: NightObstacle = { id, kind, lane, distance: r.distance + offset, length, direction: 1, variant: 0, pattern: "test", beat: id, resolved: false, hit: false, resolvedClock: 0 };
  r.nightObstacles.push(row);
  return row;
}

test("магнит: все треки и высоты в 10 м, каждая монета один раз, совместим с защитой", () => {
  for (const lanes of [3, 4] as const) {
    const r = ready({ world: "night-maglev", lanes });
    r.activateModifier("magnet"); r.activateModifier("shield");
    for (let lane = 0; lane < lanes; lane++) r.coins.push({ id: 800 + lane, lane, distance: r.distance + 9, height: 1 + lane * 3, resolved: false, taken: false, takenClock: 0 });
    advance(r, 0.05);
    assert.equal(useHud.getState().coins, lanes);
    advance(r, 1);
    assert.equal(useHud.getState().coins, lanes, "повторного зачёта нет");
    assert.equal(r.modifiers.has("shield"), true);
    r.activateModifier("phase");
    assert.equal(r.modifiers.has("shield"), false);
    assert.equal(r.modifiers.has("magnet"), true);
  }
});

test("фаза: все опасности без штрафа, торможения и магнитного сноса; истечение внутри челнока", () => {
  for (const kind of ["repair-bot", "repair-arm", "magnetic-zone", "shuttle", "energy-wall"] as const) for (const fps of [10, 60, 120]) {
    const r = ready({ world: "night-maglev" });
    r.activateModifier("phase");
    const row = danger(r, 990, kind, 1, r.targetLane, kind === "shuttle" ? 180 : 5);
    const lane = r.targetLane;
    const speed = r.speed;
    const score = useHud.getState().score;
    advance(r, 0.8, fps);
    assert.equal(row.hit, false);
    assert.equal(r.targetLane, lane);
    assert.ok(r.speed >= speed);
    assert.equal(useHud.getState().score, score);
    assert.equal(r.bumpClock, -10);
    assert.equal(row.resolved, true);
    assert.ok(!row.neutralized, "фаза оставляет препятствие на месте");
    advance(r, 5.8, fps);
    assert.equal(r.modifiers.has("phase"), false);
    assert.equal(r.bumpClock, -10, "нет удара после истечения внутри объекта");
  }
});

test("щит: три разных угрозы, по одному заряду, без магнитного сноса и наградной серии", () => {
  for (const fps of [10, 30, 120]) {
    const r = ready({ world: "night-maglev" });
    r.activateModifier("shield");
    const pulses: number[] = [];
    r.on(e => { if (e.type === "shield-pulse") pulses.push(e.id); });
    const lane = r.targetLane;
    const first = danger(r, 991, "magnetic-zone", 10);
    advance(r, 0.2, fps);
    assert.equal(first.resolved, true);
    assert.equal(r.modifiers.active[0].charges, 2);
    assert.equal(r.targetLane, lane);
    advance(r, 0.8, fps);
    const second = danger(r, 992, "repair-bot", 10);
    advance(r, 0.2, fps);
    const third = danger(r, 993, "energy-wall", 12);
    advance(r, 0.2, fps);
    assert.equal(second.resolved, true);
    assert.equal(third.resolved, true);
    assert.deepEqual(pulses, [991, 992, 993]);
    assert.equal(r.modifiers.has("shield"), false);
    assert.equal(r.bumpClock, -10);
    assert.equal(r.rewards, 0);
  }
});

test("щит учитывает физическую траекторию при перестроении и не тратится на соседний трек", () => {
  const r = ready({ world: "night-maglev", lanes: 4 });
  r.activateModifier("shield");
  const other = danger(r, 995, "repair-bot", 10, 3);
  advance(r, 0.1);
  assert.equal(other.resolved, false);
  assert.equal(r.modifiers.active[0].charges, 3);
  r.setLane(3);
  advance(r, 0.2);
  assert.equal(other.resolved, true);
  assert.equal(r.modifiers.active[0].charges, 2);
  assert.ok(r.runnerX < laneX(3, 4), "импульс предсказывает ещё идущее перестроение");
});

test("защита сохраняет уже набранную чистую серию, не увеличивая её длину", () => {
  const r = run({ world: "night-maglev", customSeconds: 20 }, 1);
  while (!r.gate) r.update(1 / 60);
  const jumpOver = (id: number) => {
    danger(r, id, "repair-bot", 4);
    r.jump(); advance(r, 1);
  };
  jumpOver(980);
  r.activateModifier("shield"); danger(r, 981, "magnetic-zone", 10); advance(r, 0.2);
  r.activateModifier("phase"); danger(r, 982, "energy-wall", 1); advance(r, 0.3);
  advance(r, 6);
  jumpOver(983);
  r.gate!.distance = r.distance + 1;
  advance(r, 5);
  const result = useHud.getState().result!;
  assert.equal(result.bestClean, 2, "сохранились два самостоятельных прыжка, защиты не добавили рядов");
  assert.equal(result.bumps, 0);
  assert.deepEqual(result.impacts, { graze: 0, hit: 0, crash: 0 });
});

test("спавн на новой трассе: все темпы, догрузка сохраняет предметы и не добавляет их в видимой зоне", () => {
  for (const world of ["classic", "night-maglev"] as const) for (const pace of ["fast", "normal", "calm", "custom"] as const) {
    const r = run({ world, pace, customSeconds: 12, obstacles: true, moreObstacles: true, lanes: 4 }, 8, true);
    const original = r.pickups.map(p => ({ ...p }));
    const seen = new Set(original.map(p => p.id));
    let added = 0;
    r.on(e => {
      if (e.type !== "course") return;
      for (const p of r.pickups) if (!seen.has(p.id)) {
        assert.ok(p.distance - r.distance > 180, `${world}/${pace}: предмет появился в видимой зоне: ${p.distance - r.distance}`);
        seen.add(p.id); added++;
      }
    });
    r.appendItems(Array.from({ length: 22 }, (_, i) => ({ ...item, id: `live${i}`, seq: i + 8 })));
    assert.deepEqual(r.pickups, original);
    r.endLive();
    if (r.night) r.speedControl.factor = 2.25;
    advance(r, 320);
    assert.ok(added > 0, `${world}/${pace}: догрузка не получила предметы`);
    assert.ok(r.modifierPlanner.placed <= r.modifierPlanner.budget(30));
  }
});

test("финиш и потеря последней жизни очищают модификаторы в обоих мирах", () => {
  for (const world of ["classic", "night-maglev"] as const) {
    const r = run({ world }, 1);
    while (!r.gate) r.update(1 / 60);
    r.activateModifier(world === "classic" ? "jetpack" : "shield");
    r.gate!.distance = r.distance + 1;
    advance(r, 5);
    assert.equal(r.phase, "finished");
    assert.deepEqual(r.modifiers.active, []);
    const failed = ready({ world, lives: 3 });
    // Три ошибки должны обрабатываться обычно даже при активной защите.
    let last = "";
    for (let i = 0; i < 2500 && failed.phase !== "gameover"; i++) {
      if (failed.gate && failed.gate.gate.key !== last) {
        last = failed.gate.gate.key;
        failed.activateModifier(world === "classic" ? "jetpack" : "phase");
        failed.setLane((failed.gate.gate.correctLane + 1) % failed.lanes);
        failed.gate.distance = failed.distance + 1;
      }
      failed.update(1 / 60);
    }
    assert.equal(failed.phase, "gameover");
    assert.deepEqual(failed.modifiers.active, []);
  }
});
