// npm run dev:mock; затем playwright-cli -s=night run-code --filename=scripts/verify-night.playwright.js
async (page) => {
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(() => { window.__manualClock = true; });
  await page.goto("http://127.0.0.1:5180/");
  await page.locator(".deck-card", { hasText: "Демо" }).locator("button[title='Быстрый старт с последними настройками']").click();
  await page.waitForFunction(() => window.__run);
  const launch = async (world = "night-maglev", lanes = 3) => {
    await page.evaluate(async ({ world, lanes }) => {
      window.__lastRun = window.__run;
      const { useSession, usePreferences } = await import("/src/app/stores.ts");
      usePreferences.getState().update({ quality: "medium", reducedMotion: false, character: "student", musicVolume: 0, sfxVolume: 0 });
      const state = useSession.getState();
      state.setLaunch({ deckId: window.__run.options.items[0].deck_id, settings: { ...state.settings, world, lanes, count: "all", pace: "custom", customSeconds: 10, lives: 0, obstacles: true } });
    }, { world, lanes });
    await page.waitForFunction(() => window.__run !== window.__lastRun && window.__run?.phase === "intro");
    await page.evaluate(async () => {
      const r = window.__run;
      for (let i = 0; i < 1200 && !r.gate; i++) r.update(1 / 60);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    if (world === "night-maglev") await page.waitForFunction(() => window.__nightMetrics?.world === window.__run.settings.world && window.__nightMetrics?.lanes === window.__run.lanes && window.__nightMetrics?.clock === window.__run.clock);
    await page.waitForTimeout(800);
  };
  await launch();
  const input = await page.evaluate(async () => {
    const r = window.__run;
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    const key = (type, code, extra = {}) => window.dispatchEvent(new KeyboardEvent(type, { code, key: "ц", bubbles: true, ...extra }));
    const advance = seconds => { for (let i = 0; i < seconds * 60; i++) r.update(1 / 60); };
    key("keydown", "KeyW"); advance(2); check(Math.abs(r.speedFactor - 1.5) < 1e-6, "W разгон");
    key("keydown", "ArrowUp"); key("keyup", "KeyW"); check(r.speedControl.accelerating, "дублер удержан");
    key("keyup", "ArrowUp"); advance(0.2); check(Math.abs(r.speedFactor - 1.5) < 1e-6, "фиксация скорости");
    key("keydown", "KeyW"); key("keydown", "KeyS"); advance(1); check(Math.abs(r.speedFactor - 1) < 1e-6, "приоритет торможения");
    key("keyup", "KeyS"); key("keyup", "KeyW");
    key("keydown", "KeyW"); r.pause(); key("keydown", "ArrowUp"); r.resume(); check(!r.speedControl.accelerating, "газ во время паузы");
    key("keyup", "KeyW"); key("keyup", "ArrowUp");
    key("keydown", "KeyW"); window.dispatchEvent(new Event("blur")); check(r.phase === "paused" && !r.speedControl.accelerating, "потеря фокуса"); r.resume();
    key("keyup", "KeyW"); key("keydown", "Space"); check(r.airborne, "магнитный прыжок"); advance(0.9);
    key("keydown", "ShiftLeft"); advance(0.1); check(r.slideDepth() > 0, "снижение");
    advance(1);
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const progress = 1 - r.gateProgress();
    check(Math.abs(Number(/scaleX\((.*?)\)/.exec(document.querySelector(".board-timer span").style.transform)[1]) - progress) < 1e-5, "HUD по дистанции");
    return { factor: r.speedFactor, progress };
  });
  const quality = await page.evaluate(async () => {
    const { usePreferences } = await import("/src/app/stores.ts");
    const out = [];
    for (const quality of ["low", "medium", "high", "auto"]) {
      usePreferences.getState().update({ quality });
      await new Promise(resolve => setTimeout(resolve, quality === "auto" ? 9000 : 1200));
      const samples = [];
      for (let i = 0; i < 30; i++) { await new Promise(requestAnimationFrame); samples.push(window.__nightMetrics); }
      out.push({ quality, averageMs: samples.reduce((sum, m) => sum + m.frameMs, 0) / samples.length, ...samples.at(-1), dpr: window.__gl.getPixelRatio() });
    }
    usePreferences.getState().update({ quality: "medium" });
    return out;
  });
  await launch("night-maglev", 4);
  await page.screenshot({ path: "../output/playwright/night-four-lanes.png" });
  const endurance = await page.evaluate(async () => {
    const run = window.__run;
    const prototype = run.gate.gate.item;
    run.appendItems(Array.from({ length: 200 }, (_, i) => ({ ...prototype, id: `endurance-${i}`, seq: 1000 + i })));
    run.setSpeedInput(true, false);
    const memory = [];
    let maxRows = 0, maxCoins = 0, maxPassed = 0;
    for (let second = 0; second < 600; second++) {
      for (let tick = 0; tick < 60; tick++) {
        const next = run.nightObstacles.find(row => !row.resolved && row.distance - run.distance < 22 && row.distance + row.length > run.distance);
        if (next) run.setLane((next.lane + 1) % run.lanes);
        else if (run.gate && run.gate.distance - run.distance < 63) run.setLane(run.gate.gate.correctLane);
        run.update(1 / 60);
        maxRows = Math.max(maxRows, run.nightObstacles.length); maxCoins = Math.max(maxCoins, run.coins.length); maxPassed = Math.max(maxPassed, run.passed.length);
      }
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (second % 60 === 59) memory.push({ second: second + 1, ...window.__nightMetrics, heap: performance.memory?.usedJSHeapSize });
    }
    if (run.phase !== "running" || maxRows > 4 || maxCoins > 8 || maxPassed > 2) throw new Error("неограниченное накопление игровых объектов");
    return { seconds: 600, distance: run.distance, maxRows, maxCoins, maxPassed, memory };
  });
  await page.screenshot({ path: "../output/playwright/night-endurance.png" });
  const replays = [];
  for (let i = 0; i < 3; i++) {
    await launch();
    replays.push(await page.evaluate(() => ({ ...window.__nightMetrics, heap: performance.memory?.usedJSHeapSize })));
  }
  await page.screenshot({ path: "../output/playwright/night-station.png" });
  await launch("classic");
  const classic = await page.evaluate(() => {
    const r = window.__run;
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyW", bubbles: true }));
    if (!r.airborne || r.speedFactor !== 1 || r.speed !== 14) throw new Error("регрессия управления классики");
    for (let i = 0; i < 55; i++) r.update(1 / 60);
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyS", bubbles: true }));
    r.update(0.05);
    if (r.slideDepth() <= 0) throw new Error("регрессия подката классики");
    return { speed: r.speed, factor: r.speedFactor, slide: r.slideDepth() };
  });
  if (errors.length) throw new Error(errors.join("\n"));
  return { input, quality, endurance, replays, classic, errors };
}
