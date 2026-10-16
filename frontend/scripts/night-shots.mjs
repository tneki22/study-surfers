// Снимки ночного мира по районам: node scripts/night-shots.mjs <outDir> [width] [height] [low|medium|high] [lanes]
// mode = full — ещё и финиш на приёмном доке; REDUCED=1 — режим «меньше движения». Нужен запущенный `npm run dev:mock`. Время забега ведёт скрипт (window.__manualClock).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [outDir = "night-shots", width = "1440", height = "860", quality = "high", lanes = "3", mode = "short"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
await page.addInitScript(({ q, reduced }) => {
  localStorage.setItem("ss:preferences", JSON.stringify({
    state: { quality: q, musicVolume: 0, sfxVolume: 0, musicEnabled: false, reducedMotion: reduced, keyHints: true, character: "student" },
    version: 1,
  }));
  window.__manualClock = true;
}, { q: quality, reduced: process.env.REDUCED === "1" });

await page.goto("http://127.0.0.1:5180/");
await page.locator(".deck-card", { hasText: "Демо" }).locator("button[title='Быстрый старт с последними настройками']").first().click();
await page.waitForFunction(() => window.__run, null, { timeout: 60000 });
await page.evaluate(async (lanes) => {
  window.__lastRun = window.__run;
  const { useSession } = await import("/src/app/stores.ts");
  const state = useSession.getState();
  state.setLaunch({ deckId: window.__run.options.items[0].deck_id, settings: { ...state.settings, world: "night-maglev", lanes, count: "all", pace: "custom", customSeconds: 10, lives: 0, obstacles: true } });
}, Number(lanes));
await page.waitForFunction(() => window.__run !== window.__lastRun && window.__run?.phase === "intro", null, { timeout: 60000 });
await page.waitForFunction(() => window.__nightMetrics, null, { timeout: 120000 });
await page.waitForTimeout(1500);

const shot = async (name) => {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: join(outDir, `${name}.png`), timeout: 180000 });
  const metrics = await page.evaluate(() => {
    const m = window.__nightMetrics; const r = window.__run;
    return { distance: Math.round(r.distance), phase: r.phase, calls: m?.calls, triangles: m?.triangles };
  });
  console.log("shot", name, JSON.stringify(metrics));
};
const advanceUntil = (source, limit = 120) => page.evaluate(({ source, limit }) => {
  const run = window.__run;
  const test = new Function("run", `return (${source})(run)`);
  for (let t = 0; t < limit; t += 1 / 60) {
    if (test(run)) return true;
    // Автопилот: уходит с полосы препятствия, перед воротами встаёт на верный ответ.
    const next = run.nightObstacles.find((row) => !row.resolved && row.distance - run.distance < 22 && row.distance + row.length > run.distance);
    if (next) run.setLane((next.lane + 1) % run.lanes);
    else if (run.gate && run.gate.distance - run.distance < 63) run.setLane(run.gate.gate.correctLane);
    run.update(1 / 60);
  }
  return false;
}, { source: source.toString(), limit });

await advanceUntil((run) => run.phase === "intro" && run.phaseClock > 1.2);
await shot("01-intro");
await advanceUntil((run) => run.phase === "running" && run.distance > 20);
await shot("02-station");
// Районы идут по 144 м: станция, виадук, неоновый квартал, тоннель (цикл 576 м).
await advanceUntil((run) => run.distance % 576 > 160 && run.distance % 576 < 175);
await shot("03-viaduct");
await advanceUntil((run) => run.distance % 576 > 300 && run.distance % 576 < 315);
await shot("04-canyon");
await advanceUntil((run) => run.distance % 576 > 445 && run.distance % 576 < 460);
await shot("05-gallery");
await advanceUntil((run) => run.nightObstacles.some((row) => !row.resolved && row.distance - run.distance < 26 && row.distance - run.distance > 12), 90);
await shot("06-obstacle");
if (mode === "full") {
  await advanceUntil((run) => run.phase === "finished" || run.phase === "gameover", 900);
  await advanceUntil((run) => run.phaseClock > 1.6, 5);
  await shot("07-finish");
}
console.log("errors:", errors.length ? errors.join("\n") : "нет");
await browser.close();
