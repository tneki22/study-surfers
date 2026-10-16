// Превью миров для экрана «Забег»: node scripts/world-previews.mjs <outDir> [nvidia|intel]
// Нужен запущенный dev-сервер (dev или dev:mock) на 5180. Снимки — кадры самой игры на высоком качестве,
// без HUD, в пропорциях карточки 2,2 : 1. Затем PNG сжимаются в public/previews/*.webp шириной 880 px.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [outDir = "previews", gpu = "nvidia", url = "http://127.0.0.1:5180"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });

const SHOTS = [
  // Ночью — неоновый квартал (третий район цикла 576 м), днём — бег между поездами.
  { world: "night-maglev", until: "(run) => run.phase === 'running' && run.distance % 576 > 318 && run.distance % 576 < 324" },
  { world: "classic", until: "(run) => run.phase === 'running' && run.distance > 150" },
];

const browser = await chromium.launch({
  channel: "chrome",
  args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", ...(gpu === "nvidia" ? ["--force_high_performance_gpu"] : [])],
});
for (const shot of SHOTS) {
  const page = await browser.newPage({ viewport: { width: 1707, height: 960 } });
  await page.addInitScript(() => {
    localStorage.setItem("ss:preferences", JSON.stringify({
      state: { quality: "high", musicVolume: 0, sfxVolume: 0, musicEnabled: false, reducedMotion: false, keyHints: false, character: "rogue-hooded", showFps: false },
      version: 1,
    }));
  });
  await page.goto(url);
  await page.locator(".deck-card", { hasText: "Демо" }).locator("button[title='Быстрый старт с последними настройками']").first().click();
  await page.waitForFunction(() => window.__run, null, { timeout: 60000 });
  await page.evaluate(async (world) => {
    window.__lastRun = window.__run;
    const { useSession } = await import("/src/app/stores.ts");
    const state = useSession.getState();
    state.setLaunch({ deckId: window.__run.options.items[0].deck_id, settings: { ...state.settings, world, lanes: 3, count: "all", pace: "custom", customSeconds: 12, lives: 0, obstacles: true } });
  }, shot.world);
  await page.waitForFunction(() => window.__run !== window.__lastRun && ["intro", "countdown", "running"].includes(window.__run?.phase), null, { timeout: 120000 });
  await page.waitForTimeout(1500);
  await page.evaluate((source) => {
    window.__manualClock = true;
    const run = window.__run;
    const done = new Function("run", `return (${source})(run)`);
    for (let t = 0; t < 120 && !done(run); t += 1 / 60) {
      if (run.gate && run.gate.distance - run.distance < 60) run.setLane(run.gate.gate.correctLane);
      run.update(1 / 60);
    }
  }, shot.until);
  await page.addStyleTag({ content: ".hud { display: none !important; }" });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: join(outDir, `world-${shot.world}.png`), clip: { x: 0, y: 130, width: 1707, height: 776 } });
  console.log("снят", shot.world);
  await page.close();
}
await browser.close();
