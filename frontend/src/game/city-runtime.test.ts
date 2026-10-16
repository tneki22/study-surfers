import assert from "node:assert/strict";
import test from "node:test";
import type { QuizItem } from "../api/types";
import { DECK_HEIGHT, HANDCAR_SPEED, HANDCAR_TRIGGER, STEP_UP } from "./engine/obstacles";
import { DEFAULT_SETTINGS, type Pace } from "./engine/settings";
import { GameRuntime } from "./runtime";

const item: QuizItem = { id: "q1", deck_id: "deck", question_id: null, seq: 1, section: null, prompt: "2+2?", correct: "4", explanation: "", source: "user_docs", enabled: true, edited: false, evidence_quote: null, stats: null, created_at: "", updated_at: "", distractors: [{ text: "3", kind: "far", why_wrong: "" }, { text: "5", kind: "near", why_wrong: "" }, { text: "6", kind: "far", why_wrong: "" }] };

function city(seed: number, lanes: 3 | 4, more: boolean, pace: Pace) {
  const items = Array.from({ length: 16 }, (_, i) => ({ ...item, id: `q${i}` }));
  return new GameRuntime({
    settings: { ...DEFAULT_SETTINGS, world: "classic", count: "all", lanes, pace, obstacles: true, moreObstacles: more, lives: 0 },
    items, live: false, previousBest: null, seed, onComplete: () => {},
  });
}

/**
 * Идеальный игрок: сразу уходит на трек верного ответа и стоит на нём, а на
 * своём треке вовремя прыгает, подкатывается и заскакивает на вагонетки.
 */
function autopilot(run: GameRuntime) {
  let met = 0;
  let hits = 0;
  const patterns = new Set<string>();
  run.on((event) => {
    if (event.type !== "obstacle") return;
    met += 1;
    if (event.hit) hits += 1;
  });
  run.start();
  while (run.phase !== "finished" && run.phase !== "gameover" && run.clock < 600) {
    if (run.gate && run.gate.chosenLane === null) run.setLane(run.gate.gate.correctLane);
    const next = run.obstacles
      .filter((row) => !row.resolved && row.lane === run.targetLane && row.distance >= run.distance && row.kind !== "ramp" && row.kind !== "slope")
      .sort((a, b) => a.distance - b.distance)[0];
    if (next) {
      patterns.add(next.pattern);
      // Дрезина едет навстречу: время до встречи — по сумме скоростей.
      const moving = next.kind === "handcar" && next.distance - run.distance < HANDCAR_TRIGGER;
      const t = (next.distance - run.distance) / Math.max(1, run.speed + (moving ? HANDCAR_SPEED : 0));
      if ((next.kind === "hurdle" || next.kind === "handcar") && t < 0.33) run.jump();
      if (next.kind === "bar" && t < 0.2 && run.slideProgress() < 0) run.slide();
      if (next.kind === "wagons" && t < 0.3 && run.feet < DECK_HEIGHT - STEP_UP - 0.2) run.jump();
    }
    run.update(1 / 60);
  }
  return { met, hits, patterns, rewards: run.rewards };
}

test("город: на треке верного ответа каждое препятствие проходимо на месте — ни одного удара", () => {
  const seen = new Set<string>();
  let rewards = 0;
  for (const lanes of [3, 4] as const) {
    for (const more of [false, true]) {
      for (const pace of ["fast", "normal", "calm"] as const) {
        for (let seed = 1; seed <= 4; seed += 1) {
          const result = autopilot(city(seed * 97 + lanes, lanes, more, pace));
          for (const pattern of result.patterns) seen.add(pattern);
          rewards += result.rewards;
          assert.equal(result.hits, 0, `${lanes} трека, ${more ? "больше" : "обычно"}, ${pace}, seed ${seed}: ударов ${result.hits} из ${result.met}`);
          assert.ok(result.met >= 4, `${lanes}/${more}/${pace}/${seed}: встречено всего ${result.met}`);
        }
      }
    }
  }
  for (const pattern of ["intro-hurdle", "intro-bar", "intro-wagons", "pair", "wall", "ladder", "double", "train", "jump-dive", "wall-ladder", "handcar"]) {
    assert.ok(seen.has(pattern), `автопилот не встретил «${pattern}»`);
  }
  // Чистый бег заслуживает катапульту.
  assert.ok(rewards >= 10, `наград за чистые серии: ${rewards}`);
});

test("город: вбежать в вагонетки сбоку с земли — задеть борт и вскарабкаться, на крыше — перейти без удара", () => {
  const run = city(5, 3, false, "normal");
  run.start();
  while (!run.gate) run.update(1 / 60);
  // Состав на соседнем треке, бегун рядом с ним на земле.
  const lane = run.targetLane;
  const side = lane === 0 ? 1 : lane - 1;
  run.obstacles.push({ id: 900, distance: run.distance + 2, lane: side, kind: "wagons", length: 15, variant: 0, pattern: "test", beat: 0, resolved: false, met: false, hit: false, resolvedClock: 0 });
  let hits = 0;
  run.on((event) => { if (event.type === "obstacle" && event.hit) hits += 1; });
  for (let i = 0; i < 30; i += 1) run.update(1 / 60);
  run.setLane(side);
  for (let i = 0; i < 40; i += 1) run.update(1 / 60);
  assert.equal(hits, 1, "удар о борт");
  assert.ok(run.feet >= DECK_HEIGHT - 1e-6, "бегун на крыше");
  assert.equal(run.deck?.id, 900);
});

test("город: удар замедляет, повтор «на хвосте» — крушение, а время до ворот почти не меняется", () => {
  const clean = city(11, 3, false, "calm");
  const bumped = city(11, 3, false, "calm");
  for (const run of [clean, bumped]) {
    run.start();
    while (!run.gate) run.update(1 / 60);
  }
  const gateAt = clean.gate!.distance;
  const severities: (string | null)[] = [];
  bumped.on((event) => { if (event.type === "obstacle" && event.hit) severities.push(event.severity); });
  // Два барьера прямо на пути, без прыжка.
  for (const [offset, id] of [[6, 801], [20, 802]] as const) {
    bumped.obstacles.push({ id, distance: bumped.distance + offset, lane: bumped.targetLane, kind: "hurdle", length: 0, variant: 0, pattern: "test", beat: 0, resolved: false, met: false, hit: false, resolvedClock: 0 });
  }
  let slowest = Infinity;
  const arrive = (run: GameRuntime) => {
    while (run.distance < gateAt && run.clock < 300) {
      run.update(1 / 60);
      if (run === bumped && run.clock > 0) slowest = Math.min(slowest, run.speed);
    }
    return run.clock;
  };
  const late = arrive(bumped) - arrive(clean);
  assert.deepEqual(severities, ["hit", "crash"]);
  assert.ok(slowest < 14 * 0.6, `скорость после удара ${slowest}`);
  assert.ok(Math.abs(late) < 0.15, `ворота позже на ${late.toFixed(2)} с`);
});

test("объезд и возврат на трек не обнуляют бонус за раннее решение", () => {
  const run = city(3, 3, false, "calm");
  run.start();
  while (!run.gate) run.update(1 / 60);
  const lane = run.gate!.gate.correctLane;
  run.setLane(lane);
  for (let i = 0; i < 30; i += 1) run.update(1 / 60);
  const decided = run.gate!.lastChangeAt;
  run.setLane(lane === 0 ? 1 : lane - 1);
  for (let i = 0; i < 20; i += 1) run.update(1 / 60);
  run.setLane(lane);
  const away = run.gate!.lastChangeAt - decided;
  // Потеряны только метры в стороне (20 кадров ≈ 4,7 м), а не всё время с начала вопроса.
  assert.ok(away > 3 && away < 6, `сдвиг решения ${away.toFixed(1)} м`);
  // Долгий уход — уже смена решения.
  run.setLane(lane === 0 ? 1 : lane - 1);
  for (let i = 0; i < 120; i += 1) run.update(1 / 60);
  run.setLane(lane);
  assert.ok(Math.abs(run.gate!.lastChangeAt - run.distance) < 1e-6);
});

test("итоги: чистые препятствия, лучшая чистая серия и столкновения по силе; погоня 4 с", () => {
  let result: import("./store").RunResult | null = null;
  const items = Array.from({ length: 4 }, (_, i) => ({ ...item, id: `q${i}` }));
  const run = new GameRuntime({
    settings: { ...DEFAULT_SETTINGS, world: "classic", count: "all", lanes: 3, pace: "calm", obstacles: true, lives: 0 },
    items, live: false, previousBest: null, seed: 4, onComplete: (r) => { result = r; },
  });
  run.start();
  while (!run.gate) run.update(1 / 60);
  run.obstacles = [];
  const put = (offset: number, id: number) => run.obstacles.push({ id, distance: run.distance + offset, lane: run.targetLane, kind: "hurdle", length: 0, variant: 0, pattern: "test", beat: 0, resolved: false, met: false, hit: false, resolvedClock: 0 });
  // Три чистых прыжка, затем удар без прыжка.
  for (const [offset, id] of [[8, 701], [30, 702], [52, 703], [80, 704]] as const) put(offset, id);
  let chased = false;
  while (run.obstacles.some((row) => !row.resolved)) {
    // Трасса впереди достраивается — оставляем только свои барьеры.
    run.obstacles = run.obstacles.filter((row) => row.id >= 700 && row.id < 710);
    const next = run.obstacles.find((row) => !row.resolved);
    if (next && next.id !== 704 && (next.distance - run.distance) / run.speed < 0.33) run.jump();
    run.update(1 / 60);
    if (run.chase() > 0) chased = true;
  }
  assert.ok(chased);
  run.quit();
  run.obstacles = [];
  for (let i = 0; i < 60 * 4.1; i += 1) run.update(1 / 60);
  assert.equal(run.chase(), 0, "погоня кончилась через CHASE_SECONDS");
  const final = result as import("./store").RunResult | null;
  assert.ok(final);
  assert.equal(final.bestClean, 3);
  assert.deepEqual(final.impacts, { graze: 0, hit: 1, crash: 0 });
  assert.equal(final.bumps, 1);
});
