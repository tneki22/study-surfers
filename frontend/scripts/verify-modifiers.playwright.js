// npm run dev:mock; из корня: playwright-cli -s=modifiers run-code --filename=frontend/scripts/verify-modifiers.playwright.js
// Артефакты — output/playwright/ в рабочем каталоге CLI. Игровое время ведём вручную.
async (page) => {
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  await page.addInitScript(() => { window.__manualClock = true; });
  await page.setViewportSize({ width: 1440, height: 900 });
  if (!page.url().includes("/play/")) {
    await page.goto("http://127.0.0.1:5180/");
    await page.evaluate(async () => {
      window.__manualClock = true;
      const { usePreferences } = await import("/src/app/stores.ts");
      usePreferences.getState().update({ quality: "low", musicVolume: 0, sfxVolume: 0 });
    });
    await page.getByRole("button", { name: "Бежать", exact: true }).first().click();
    await page.waitForURL(/\/(setup|play\/[^/]+)$/);
    if (page.url().includes("/setup")) await page.getByRole("button", { name: "Бежать!", exact: true }).click();
  }
  await page.reload();
  await page.waitForFunction(() => window.__run && window.__session && window.__preferences);
  const launch = async ({ world = "classic", lanes = 4, character = "rogue-hooded", quality = "low", reducedMotion = false } = {}) => {
    await page.evaluate(async ({ world, lanes, character, quality, reducedMotion }) => {
      window.__manualClock = true;
      const { DEFAULT_SETTINGS } = await import("/src/game/engine/settings.ts");
      window.__oldRun = window.__run;
      window.__oldScene = window.__scene;
      window.__preferences.getState().update({ quality, character, reducedMotion, musicVolume: 0, sfxVolume: 0 });
      window.__session.getState().setLaunch({ deckId: window.__run.options.items[0].deck_id,
        settings: { ...DEFAULT_SETTINGS, world, lanes, pace: "custom", customSeconds: 20, count: "all", lives: 0, modifiers: true, obstacles: true } });
    }, { world, lanes, character, quality, reducedMotion });
    await page.waitForFunction(() => window.__run !== window.__oldRun && window.__run?.phase === "intro");
    await page.waitForFunction(() => window.__scene !== window.__oldScene && window.__scene?.getObjectByName(window.__run.night ? "hover-bike" : "runner-body"));
    if (world === "classic" && character !== "student") await page.waitForFunction(() => window.__scene?.getObjectByName("footl"));
    await page.evaluate(() => { const r = window.__run; for (let i = 0; i < 1000 && !r.gate; i++) r.update(1 / 60); });
    await page.waitForTimeout(300);
  };
  const effect = async (kind, jump = false) => {
    await page.evaluate(({ kind, jump }) => {
      const r = window.__run;
      r.activateModifier(kind);
      if (jump) r.jump();
      const frames = jump ? 35 : 65;
      for (let i = 0; i < frames; i++) r.update(1 / 60);
    }, { kind, jump });
    await page.waitForTimeout(650);
  };
  const inspect = async (label, { gear = null, shoes = false, bodyVisible = true } = {}) => {
    // На холодной компиляции шейдеров CSS-анимация может начаться позже тика логики.
    await page.waitForFunction(() => {
      const cards = [...document.querySelectorAll(".lane-card")];
      return cards.length === window.__run.lanes && cards.every(card => Number(getComputedStyle(card).opacity) >= 0.99);
    });
    const result = await page.evaluate(async ({ label, gear, shoes, bodyVisible }) => {
      const { Box3, Vector3 } = await import("/node_modules/three/build/three.module.js");
      const r = window.__run, scene = window.__scene, camera = window.__camera;
      const rect = document.querySelector("canvas").getBoundingClientRect();
      const body = scene.getObjectByName(r.night ? "hover-bike" : "runner-body");
      scene.updateMatrixWorld(true); camera.updateMatrixWorld(true);
      const bounds = new Box3().setFromObject(body, true);
      const screen = [];
      for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
        const p = new Vector3(x, y, z).project(camera);
        screen.push({ x: rect.left + (p.x + 1) * rect.width / 2, y: rect.top + (1 - p.y) * rect.height / 2 });
      }
      const b = { left: Math.min(...screen.map(p => p.x)), right: Math.max(...screen.map(p => p.x)), top: Math.min(...screen.map(p => p.y)), bottom: Math.max(...screen.map(p => p.y)) };
      const cards = [...document.querySelectorAll(".lane-card")].map(card => ({ text: card.textContent, opacity: getComputedStyle(card).opacity, box: card.getBoundingClientRect().toJSON() }));
      const badges = [...document.querySelectorAll(".modifier-badge")].map(badge => badge.getBoundingClientRect().toJSON());
      const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
      if (cards.length !== r.lanes || cards.some(c => Number(c.opacity) < 0.99 || !c.text.trim())) throw new Error(`${label}: карточки скрыты`);
      const hints = document.querySelector(".key-hints");
      if (innerHeight < 520 && hints && getComputedStyle(hints).display !== "none") throw new Error(`${label}: клавиши закрывают HUD`);
      if (cards.some(c => badges.some(b => overlaps(c.box, b)))) throw new Error(`${label}: HUD перекрывает ответ`);
      if (bodyVisible && (b.left < -2 || b.right > innerWidth + 2 || b.top < 0 || b.bottom > innerHeight + 2)) throw new Error(`${label}: модель за кадром ${JSON.stringify(b)}`);
      if (!r.night && bodyVisible && cards.some(c => overlaps(c.box, b))) throw new Error(`${label}: модель перекрывает ответы ${JSON.stringify(b)}`);
      if (gear && !scene.getObjectByName(gear)?.visible) throw new Error(`${label}: нет экипировки ${gear}`);
      let soleError = null;
      if (shoes) {
        const soles = []; scene.traverse(o => { if (o.name === "modifier-gravity-sole") soles.push(o); });
        if (soles.length !== 2 || soles.some(s => !s.visible)) throw new Error(`${label}: нет подошв`);
        if (scene.getObjectByName("footl")) {
          soleError = Math.max(...["footl", "footr"].map((name, i) => soles[i].position.distanceTo(scene.getObjectByName(name).getWorldPosition(new Vector3()))));
          if (soleError > 0.11) throw new Error(`${label}: подошва ушла от кости ${soleError}`);
        }
      }
      const marker = scene.getObjectByName("flight-lane-marker");
      const markerScreen = marker?.visible ? marker.getWorldPosition(new Vector3()).project(camera) : null;
      if (!r.night && r.airborne && (!markerScreen || Math.abs(markerScreen.x) > 1 || Math.abs(markerScreen.y) > 1)) throw new Error(`${label}: не видна метка трека`);
      return { label, feet: r.feet, bounds: b, cards: cards.length, soleError, effects: r.modifiers.active.map(e => e.kind) };
    }, { label, gear, shoes, bodyVisible });
    await page.screenshot({ path: `output/playwright/modifier-${label}.png` });
    return result;
  };
  const results = [];
  const characters = ["rogue-hooded", "rogue", "knight", "mage", "barbarian", "student"];
  for (const [i, character] of characters.entries()) {
    await launch({ character, lanes: i % 2 ? 3 : 4 });
    await effect("jetpack");
    results.push(await inspect(`${character}-jetpack`, { gear: "modifier-jetpack" }));
    await page.evaluate(() => { const r = window.__run; for (let i = 0; i < 420; i++) r.update(1 / 60); });
    await effect("gravity-shoes", true);
    results.push(await inspect(`${character}-shoes`, { shoes: true }));
  }
  for (const quality of ["medium", "high", "auto"]) {
    await launch({ quality }); await effect("jetpack");
    results.push(await inspect(`quality-${quality}`, { gear: "modifier-jetpack" }));
  }
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) for (const lanes of [3, 4]) {
    await page.setViewportSize(size);
    await launch({ lanes, reducedMotion: true }); await effect("jetpack");
    for (const lane of [0, lanes - 1]) {
      await page.evaluate(lane => { const r = window.__run; r.setLane(lane); for (let i = 0; i < 45; i++) r.update(1 / 60); }, lane);
      await page.waitForTimeout(300);
      results.push(await inspect(`${size.width}x${size.height}-${lanes}lanes-edge${lane}`, { gear: "modifier-jetpack" }));
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const [i, character] of characters.entries()) {
    await launch({ world: "night-maglev", lanes: i % 2 ? 3 : 4, character, quality: i < 2 ? "medium" : "low", reducedMotion: i === 5 });
    await page.evaluate(() => { window.__run.speedControl.factor = 2.25; });
    await effect("magnet"); await effect("phase");
    results.push(await inspect(`${character}-magnet-phase`, { gear: "modifier-magnet", bodyVisible: false }));
    await effect("shield");
    results.push(await inspect(`${character}-shield`, { gear: "modifier-defence-shell", bodyVisible: false }));
    const pause = await page.evaluate(() => { const r = window.__run; r.pause(); return { clock: r.clock, charges: r.modifiers.active.find(e => e.kind === "shield").charges, matrix: window.__scene.getObjectByName("hover-bike").matrixWorld.toArray() }; });
    await page.waitForTimeout(200);
    check(await page.evaluate(before => { const r = window.__run; r.update(20); return r.clock === before.clock && r.modifiers.active.find(e => e.kind === "shield").charges === before.charges && JSON.stringify(window.__scene.getObjectByName("hover-bike").matrixWorld.toArray()) === JSON.stringify(before.matrix); }, pause), "Пауза меняет состояние");
    await page.evaluate(() => window.__run.resume());
  }
  await launch({ world: "night-maglev", lanes: 4, quality: "medium" });
  await effect("phase");
  await page.evaluate(() => {
    const r = window.__run;
    r.nightObstacles.push({ id: 900001, kind: "energy-wall", lane: r.targetLane, distance: r.distance + 30, length: 0.6, direction: 1, variant: 0, pattern: "modifier-qa", beat: 900001, resolved: false, hit: false, resolvedClock: 0 });
    r.emit({ type: "course" }); r.update(0.1);
  });
  await page.waitForTimeout(400);
  results.push(await inspect("phase-near-danger", { gear: "modifier-defence-shell", bodyVisible: false }));
  await page.evaluate(() => {
    const r = window.__run;
    r.nightObstacles = [];
    r.activateModifier("shield");
    r.nightObstacles.push({ id: 900002, kind: "repair-bot", lane: r.targetLane, distance: r.distance + 11, length: 1.6, direction: 1, variant: 0, pattern: "modifier-qa", beat: 900002, resolved: false, hit: false, resolvedClock: 0 });
    r.emit({ type: "course" }); for (let i = 0; i < 12; i++) r.update(1 / 60);
    if (r.modifiers.active.find(e => e.kind === "shield").charges !== 2 || !r.nightObstacles[0].neutralized) throw new Error("Нет первого импульса");
  });
  await page.waitForTimeout(250);
  results.push(await inspect("shield-pulse", { gear: "modifier-defence-shell", bodyVisible: false }));
  await page.evaluate(() => {
    const r = window.__run;
    for (const [i, kind] of ["energy-wall", "magnetic-zone"].entries()) {
      r.nightObstacles.push({ id: 900003 + i, kind, lane: r.targetLane, distance: r.distance + 11, length: 1, direction: 1, variant: 0, pattern: "modifier-qa", beat: 900003 + i, resolved: false, hit: false, resolvedClock: 0 });
      r.emit({ type: "course" }); for (let j = 0; j < 10; j++) r.update(1 / 60);
    }
    if (r.modifiers.has("shield")) throw new Error("Щит не исчерпан");
  });
  await page.waitForTimeout(250);
  results.push(await inspect("shield-three-pulses", { bodyVisible: false }));
  await page.evaluate(() => {
    const r = window.__run;
    r.activateModifier("magnet");
    for (let lane = 0; lane < r.lanes; lane++) r.coins.push({ id: 900010 + lane, lane, distance: r.distance + 9, height: 1 + lane, resolved: false, taken: false, takenClock: 0 });
    r.emit({ type: "course" }); for (let i = 0; i < 10; i++) r.update(1 / 60);
    if (r.coins.filter(c => c.id >= 900010 && c.taken).length !== 4) throw new Error("Магнит не собрал четыре высоты");
  });
  await page.waitForTimeout(250);
  results.push(await inspect("magnet-attraction", { gear: "modifier-magnet", bodyVisible: false }));
  check(errors.length === 0, `Ошибки браузера: ${errors.join("; ")}`);
  await page.evaluate(results => { window.__modifierQA = results; }, results);
  return { checked: results.length, maxSoleError: Math.max(...results.map(r => r.soleError ?? 0)), errors };
}
