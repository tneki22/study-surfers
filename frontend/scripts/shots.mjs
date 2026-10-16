// Скриншоты и автопрогон забега headless-браузером:
//   node scripts/shots.mjs <outDir> [width] [height] [short|full] [auto|low|medium|high] [герой] [триггеры]
// Герой — id из src/game/scene/runner/characters.ts (student — процедурный бегун).
// Триггеры — JSON с дистанцией до препятствия, на которой автопилот жмёт кнопку,
// например {"hurdle":1.8,"bar":1.1}: так проверяются крайние, но ещё засчитанные моменты.
// Нужен запущенный `npm run dev:mock`. Программный рендер (swiftshader) медленный,
// поэтому время забега ведёт скрипт (window.__manualClock + __run.update), а кадры
// рисуются только там, где они нужны: для снимков и пока препятствие проходит
// сквозь бегуна — тогда щуп зазоров (ClearanceProbe) меряет настоящую позу.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [outDir = "shots", width = "1440", height = "860", mode = "short", quality = "medium", character = "rogue-hooded", triggers = "{}"] = process.argv.slice(2);
const TRIGGER = { hurdle: 4, bar: 2.6, wagons: 3.4, ...JSON.parse(triggers) };
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});
await page.addInitScript(({ q, hero }) => {
  localStorage.setItem("ss:preferences", JSON.stringify({
    state: { quality: q, musicVolume: 0.35, sfxVolume: 0.7, musicEnabled: true, reducedMotion: false, keyHints: true, character: hero },
    version: 1,
  }));
  window.__manualClock = true;
}, { q: quality, hero: character });

const state = () => page.evaluate(() => {
  const run = window.__run;
  return run && {
    phase: run.phase,
    distance: Math.round(run.distance),
    feet: Number(run.feet.toFixed(2)),
    gate: run.gate ? Math.round(run.gate.distance - run.distance) : null,
    obstacles: run.obstacles.filter((o) => !o.resolved).map((o) => `${o.kind}@${Math.round(o.distance - run.distance)}`),
  };
});

const shot = async (name) => {
  // Пара настоящих кадров, чтобы сцена догнала состояние рантайма.
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(outDir, `${name}.png`), timeout: 180000 });
  console.log("shot", name, JSON.stringify(await state()));
};

/** Прокрутить логику забега на `seconds` секунд игрового времени. */
const advance = (seconds) => page.evaluate((s) => {
  const run = window.__run;
  for (let t = 0; t < s; t += 1 / 60) run.update(1 / 60);
}, seconds);

/** Крутить, пока условие на рантайме не выполнится (не дольше limit секунд). */
const advanceUntil = (predicate, limit = 60) => page.evaluate(({ source, limit: max }) => {
  const run = window.__run;
  const test = new Function("run", `return (${source})(run)`);
  for (let t = 0; t < max; t += 1 / 60) {
    if (test(run)) return true;
    run.update(1 / 60);
  }
  return false;
}, { source: predicate.toString(), limit });

/**
 * Автопилот: прыгает и подкатывается в «правильный» момент, иногда перестраивается
 * на вопросах. Останавливается, когда `stop(run)` вернёт true. Рядом с барьерами и
 * балками отдаёт кадр после каждого шага — щуп меряет позу. Пишет, какие снимки сделать.
 */
const autoplay = (stopSource, limit) => page.evaluate(async ({ stopSource: source, limit: max, TRIGGER }) => {
  const run = window.__run;
  const stop = new Function("run", `return (${source})(run)`);
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
  for (let t = 0; t < max; t += 1 / 60) {
    if (stop(run)) return true;
    const next = run.obstacles.find((o) => !o.resolved);
    if (next) {
      const ahead = next.distance - run.distance;
      if (ahead <= TRIGGER[next.kind] && !run.airborne && run.slideProgress() < 0) {
        if (next.kind === "bar") run.slide();
        else run.jump();
      }
    }
    if (run.gate && run.gate.distance - run.distance > 30 && Math.random() < 0.004) run.moveLane(Math.random() < 0.5 ? -1 : 1);
    run.update(1 / 60);
    if (run.obstacles.some((o) => o.kind !== "wagons" && Math.abs(o.distance - run.distance) < 0.8)) await frame();
  }
  return false;
}, { stopSource: stopSource.toString(), limit, TRIGGER });

await page.goto("http://127.0.0.1:5180/");
// Демо-колода (16 карточек), иначе первая колода, которую уже можно бежать.
const quickStart = "button[title=\"Быстрый старт с последними настройками\"]:not([disabled])";
const demo = page.locator(".deck-card", { hasText: "Демо" }).locator(quickStart);
await (await demo.count() ? demo : page.locator(quickStart)).first().click();
await page.waitForFunction(() => window.__run, null, { timeout: 60000 });
// Модель героя догружается в Suspense — ждём, пока в сцене появится тело.
await page.waitForTimeout(1500);

await advanceUntil((run) => run.phase === "intro" && run.phaseClock > 1.0);
await shot("01-intro");
await advanceUntil((run) => run.phase === "countdown" && run.phaseClock > 0.2);
await shot("02-countdown");
await advanceUntil((run) => run.gate && run.gate.distance - run.distance < 75);
await shot("03-question");
await page.evaluate(() => window.__run.moveLane(-1));
await advance(0.35);
await shot("04-moved-left");
await advanceUntil((run) => run.passed.length > 0 && run.distance - run.passed[run.passed.length - 1].distance > 1.5);
await shot("05-after-gate");

// Первые препятствия каждого вида: снимок в момент прохода.
for (const kind of ["hurdle", "bar", "wagons"]) {
  const near = kind === "wagons"
    ? (run) => run.deck && run.distance - run.deck.distance > 5 && !run.airborne
    : new Function("run", `return run.obstacles.some((o) => o.kind === "${kind}" && o.distance - run.distance < 0.25 && o.distance - run.distance > -0.4)`);
  const found = await autoplay(near, 240);
  if (found) await shot(`06-${kind}`);
}

if (mode === "full") {
  await autoplay((run) => run.phase === "finished" || run.phase === "gameover", 900);
  await advance(0.6);
  await shot("08-finish");
  await advance(2.5);
  await page.waitForSelector(".results-card", { timeout: 60000 });
  await shot("09-results");
}

const report = await page.evaluate(() => {
  const records = window.__clearance ?? [];
  const summary = (kind) => {
    const rows = records.filter((r) => r.kind === kind && r.frames > 0);
    const cleared = rows.filter((r) => r.cleared);
    return {
      rows: rows.length,
      cleared: cleared.length,
      clippedWhileCleared: cleared.filter((r) => r.overlap > 0.005).map((r) => r.overlap.toFixed(3)),
      margin: cleared.length
        ? (kind === "hurdle" ? Math.min(...cleared.map((r) => r.lowest)) : Math.max(...cleared.map((r) => r.highest))).toFixed(3)
        : null,
    };
  };
  return { hurdle: summary("hurdle"), bar: summary("bar") };
});
console.log("clearance:", JSON.stringify(report));
console.log("errors:", errors.length ? errors.join("\n") : "нет");
await browser.close();
