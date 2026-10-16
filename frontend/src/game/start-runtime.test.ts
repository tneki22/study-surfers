import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_SETTINGS, type World } from "./engine/settings";
import { GameRuntime } from "./runtime";
import { useHud } from "./store";

function createRun(world: World) {
  return new GameRuntime({
    settings: { ...DEFAULT_SETTINGS, world }, items: [], live: true,
    previousBest: null, seed: 1, onComplete: () => {},
  });
}

function advanceToRun(run: GameRuntime) {
  let elapsed = 0;
  while ((run.phase === "intro" || run.phase === "countdown") && elapsed < 6) {
    run.update(1 / 60);
    elapsed += 1 / 60;
  }
  assert.equal(run.phase, "running");
  return elapsed;
}

for (const world of ["classic", "night-maglev"] as const) {
  test(`${world}: ускорение сохраняет 3–2–1 и обычную скорость забега`, () => {
    const normal = createRun(world);
    normal.start();
    const normalElapsed = advanceToRun(normal);
    assert.ok(normalElapsed > 4.8 && normalElapsed < 5);
    normal.update(0.25);
    const normalDistance = normal.distance;
    const normalSpeed = normal.speed;

    const fast = createRun(world);
    const counts: number[] = [];
    fast.on((event) => { if (event.type === "countdown") counts.push(event.value); });
    assert.equal(fast.accelerateStart(), false, "загрузка не перематывается");
    fast.start();
    fast.accelerateStart();
    fast.accelerateStart();
    fast.accelerateStart();
    fast.accelerateStart();
    assert.ok(advanceToRun(fast) < 0.5, "быстрые нажатия сокращают весь старт до полусекунды");
    assert.deepEqual(counts, [3, 2, 1, 0]);
    assert.equal(fast.distance, 0, "до старта трасса не движется");
    assert.equal(fast.accelerateStart(), false);
    const clock = fast.clock;
    fast.update(0.25);
    assert.ok(Math.abs(fast.clock - clock - 0.25) < 1e-8);
    assert.equal(fast.distance, normalDistance);
    assert.equal(fast.speed, normalSpeed);
  });

  test(`${world}: можно ускорить уже начавшийся отсчёт, пауза сохраняется`, () => {
    const run = createRun(world);
    run.start();
    while (run.phase === "intro") run.update(1 / 60);
    run.accelerateStart();
    run.pause();
    const clock = run.phaseClock;
    assert.equal(run.accelerateStart(), false);
    run.update(0.25);
    assert.equal(run.phaseClock, clock);
    run.resume();
    assert.ok(advanceToRun(run) < 0.6);

    createRun(world);
    assert.equal(useHud.getState().startSpeed, 1, "новый забег стартует с обычной скоростью");
  });
}
