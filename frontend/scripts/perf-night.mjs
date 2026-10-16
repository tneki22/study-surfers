// Замер кадра ночного мира на настоящей видеокарте: node scripts/perf-night.mjs [intel|nvidia] [low|medium|high|auto] [width] [height] [dpr] [url]
// Нужен запущенный dev-сервер (dev или dev:mock). Кадры не ограничены вертикальной синхронизацией: смотрим время кадра, а не 60/165 FPS монитора.
import { chromium } from "@playwright/test";

const [gpu = "intel", quality = "high", width = "1707", height = "960", dpr = "1.5", url = "http://127.0.0.1:5180"] = process.argv.slice(2);
const seconds = Number(process.env.SECONDS ?? 4);
const windows = Number(process.env.WINDOWS ?? 4);

const browser = await chromium.launch({
  channel: process.env.CHANNEL ?? "chrome",
  args: [
    "--use-angle=d3d11", "--ignore-gpu-blocklist", "--disable-gpu-vsync", "--disable-frame-rate-limit",
    "--autoplay-policy=no-user-gesture-required",
    ...(gpu === "nvidia" ? ["--force_high_performance_gpu"] : []),
  ],
});
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) }, deviceScaleFactor: Number(dpr) });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
await page.addInitScript((flags) => { window.__perfFlags = flags; }, (process.env.PERF_FLAGS ?? "").split(",").filter(Boolean));
await page.addInitScript((q) => {
  localStorage.setItem("ss:preferences", JSON.stringify({
    state: { quality: q, musicVolume: 0, sfxVolume: 0, musicEnabled: false, reducedMotion: false, keyHints: true, character: "student" },
    version: 1,
  }));
}, quality);

await page.goto(url);
const renderer = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
});
await page.locator(".deck-card", { hasText: "Демо" }).locator("button[title='Быстрый старт с последними настройками']").first().click();
await page.waitForFunction(() => window.__run, null, { timeout: 60000 });
await page.evaluate(async () => {
  window.__lastRun = window.__run;
  const { useSession } = await import("/src/app/stores.ts");
  const state = useSession.getState();
  state.setLaunch({ deckId: window.__run.options.items[0].deck_id, settings: { ...state.settings, world: "night-maglev", lanes: 3, count: "all", pace: "custom", customSeconds: 10, lives: 0, obstacles: true } });
});
await page.waitForFunction(() => window.__run !== window.__lastRun && window.__run?.phase === "running", null, { timeout: 120000 });
// Автопилот: объезжает препятствия и встаёт на верный ответ, чтобы забег шёл как у игрока.
await page.evaluate(() => {
  setInterval(() => {
    const run = window.__run;
    const next = run.nightObstacles.find((row) => !row.resolved && row.distance - run.distance < 22 && row.distance + row.length > run.distance);
    if (next) run.setLane((next.lane + 1) % run.lanes);
    else if (run.gate && run.gate.distance - run.distance < 63) run.setLane(run.gate.gate.correctLane);
  }, 50);
});
await page.waitForTimeout(2500);

const results = [];
for (let i = 0; i < windows; i++) {
  const sample = await page.evaluate((ms) => new Promise((resolve) => {
    const frames = [];
    let last = performance.now();
    const start = last;
    const tick = (now) => {
      frames.push(now - last);
      last = now;
      if (now - start < ms) requestAnimationFrame(tick);
      else {
        frames.sort((a, b) => a - b);
        const m = window.__nightMetrics ?? {};
        const canvas = document.querySelector(".game-canvas canvas");
        resolve({
          avg: frames.reduce((s, f) => s + f, 0) / frames.length,
          p95: frames[Math.floor(frames.length * 0.95)],
          calls: m.calls, triangles: m.triangles, distance: Math.round(window.__run.distance),
          buffer: canvas ? `${canvas.width}x${canvas.height}` : "?",
        });
      }
    };
    requestAnimationFrame(tick);
  }), seconds * 1000);
  results.push(sample);
}
const avg = results.reduce((s, r) => s + r.avg, 0) / results.length;
console.log(`${renderer.replace(/^ANGLE \(|, D3D11\)$/g, "")}`);
console.log(`${quality} ${width}x${height}@${dpr} буфер ${results[0].buffer}: ${avg.toFixed(2)} мс/кадр (${(1000 / avg).toFixed(0)} FPS)`);
for (const r of results) console.log(`  ${r.avg.toFixed(2)} мс, p95 ${r.p95.toFixed(1)} мс, ${r.calls} вызовов, ${(r.triangles / 1000).toFixed(0)}k треуг., дистанция ${r.distance}`);
if (errors.length) console.log("ошибки:", errors.join("\n"));
await browser.close();
