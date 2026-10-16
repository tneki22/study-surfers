import assert from "node:assert/strict";
import test from "node:test";
import type { QuizItem } from "../api/types";
import { laneX } from "./constants";
import { SHUTTLE_SPEED } from "./engine/night-obstacles";
import { DEFAULT_SETTINGS, type Pace } from "./engine/settings";
import { GameRuntime } from "./runtime";

const item: QuizItem = { id: "q1", deck_id: "deck", question_id: null, seq: 1, section: null, prompt: "2+2?", correct: "4", explanation: "", source: "user_docs", enabled: true, edited: false, evidence_quote: null, stats: null, created_at: "", updated_at: "", distractors: [{ text: "3", kind: "far", why_wrong: "" }, { text: "5", kind: "near", why_wrong: "" }, { text: "6", kind: "far", why_wrong: "" }] };

function night(seed: number, lanes: 3 | 4, more: boolean, pace: Pace) {
  const items = Array.from({ length: 14 }, (_, i) => ({ ...item, id: `q${i}` }));
  return new GameRuntime({
    settings: { ...DEFAULT_SETTINGS, world: "night-maglev", count: "all", lanes, pace, obstacles: true, moreObstacles: more, lives: 0 },
    items, live: false, previousBest: null, seed, onComplete: () => {},
  });
}

/**
 * Внимательный пилот: держит дорожку верного ответа, от магнита и челнока уходит
 * на ближайшую свободную дорожку и возвращается, через роботов прыгает, под
 * консолями снижается. `boost` — весь забег на полном газу.
 */
function pilot(run: GameRuntime, boost: boolean) {
  let met = 0;
  const hits: string[] = [];
  const patterns = new Set<string>();
  run.on((event) => {
    if (event.type !== "night-obstacle") return;
    met += 1;
    if (event.hit) hits.push(`${event.kind}@${event.lane}`);
  });
  run.start();
  const dodge = (lane: number) => run.nightObstacles.some((row) => {
    if (row.resolved || row.lane !== lane || (row.kind !== "magnetic-zone" && row.kind !== "shuttle" && row.kind !== "energy-wall")) return false;
    const ahead = row.distance - run.distance;
    const closing = row.kind === "shuttle" ? run.speed + SHUTTLE_SPEED : run.speed;
    return ahead + row.length > -1.5 && ahead < closing * 0.55 + 3;
  });
  while (run.phase !== "finished" && run.phase !== "gameover" && run.clock < 600) {
    run.setSpeedInput(boost, false);
    const answer = run.gate && run.gate.chosenLane === null ? run.gate.gate.correctLane : run.targetLane;
    let lane = answer;
    if (dodge(lane) || dodge(run.targetLane)) {
      // Уходить можно только туда, где прямо сейчас ничего не проезжает мимо байка.
      const busy = (l: number) => run.nightObstacles.some((row) => !row.resolved && row.kind !== "boost-ring" && row.lane !== run.targetLane && Math.min(l, run.targetLane) <= row.lane && row.lane <= Math.max(l, run.targetLane) && row.distance - run.distance > -row.length - 0.5 && row.distance - run.distance < run.speed * 0.35);
      const options = Array.from({ length: run.lanes }, (_, l) => l).filter((l) => !dodge(l) && !busy(l)).sort((a, b) => Math.abs(a - run.targetLane) - Math.abs(b - run.targetLane));
      if (options.length) lane = options[0];
    }
    // Возврат на дорожку ответа — тоже только через свободные дорожки.
    const crossing = (l: number) => run.nightObstacles.some((row) => !row.resolved && row.kind !== "boost-ring" && row.lane !== run.targetLane && Math.min(l, run.targetLane) <= row.lane && row.lane <= Math.max(l, run.targetLane) && row.distance - run.distance > -row.length - 0.5 && row.distance - run.distance < run.speed * 0.35);
    if (lane === run.targetLane || !crossing(lane) || dodge(run.targetLane)) run.setLane(lane);
    for (const row of run.nightObstacles) {
      if (row.resolved) continue;
      if (Math.abs(laneX(row.lane, run.lanes) - run.runnerX) > 2.2) continue;
      patterns.add(row.pattern);
      const t = (row.distance - run.distance) / Math.max(1, run.speed);
      if (row.kind === "repair-bot" && t > 0 && t < 0.3) run.jump();
      // Снижение кончается раньше консоли — нажать ещё раз, как сделал бы игрок.
      if (row.kind === "repair-arm" && t > 0 && t < 0.22 && (run.slideProgress() < 0 || run.slideProgress() > 0.6)) run.slide();
    }
    run.update(1 / 60);
  }
  return { met, hits, patterns, rewards: run.rewards };
}

test("ночь: внимательный пилот проходит все паттерны без единого удара — и на базе, и на полном газу", () => {
  const seen = new Set<string>();
  let rewards = 0;
  for (const lanes of [3, 4] as const) {
    for (const more of [false, true]) {
      for (const pace of ["fast", "normal", "calm"] as const) {
        for (const boost of [false, true]) {
          for (let seed = 1; seed <= 2; seed += 1) {
            const result = pilot(night(seed * 131 + lanes, lanes, more, pace), boost);
            for (const pattern of result.patterns) seen.add(pattern);
            rewards += result.rewards;
            assert.deepEqual(result.hits, [], `${lanes} дорожки, ${more ? "больше" : "обычно"}, ${pace}, ${boost ? "газ" : "база"}, seed ${seed}: удары из ${result.met}`);
            assert.ok(result.met >= 5, `${lanes}/${more}/${pace}/${boost}/${seed}: встречено всего ${result.met}`);
          }
        }
      }
    }
  }
  for (const pattern of ["intro-repair-bot", "intro-repair-arm", "pair", "gate", "oncoming", "magnet-trap", "barrier", "boost-ring"]) {
    assert.ok(seen.has(pattern), `пилот не встретил «${pattern}»`);
  }
  assert.ok(rewards >= 10, `колец за чистые серии: ${rewards}`);
});
