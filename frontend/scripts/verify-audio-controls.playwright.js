// npm run dev:mock; из frontend/: playwright-cli -s=audio-controls run-code --filename=scripts/verify-audio-controls.playwright.js
async (page) => {
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.addInitScript(() => { window.__manualClock = true; });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("http://127.0.0.1:5180/");
  await page.evaluate(async () => {
    const { usePreferences } = await import("/src/app/stores.ts");
    usePreferences.getState().update({ quality: "low", musicEnabled: true, musicVolume: 0.35, sfxVolume: 0.7 });
  });
  await page.getByRole("button", { name: "Бежать", exact: true }).first().click();
  await page.waitForURL(/\/(setup|play\/[^/]+)$/);
  if (page.url().endsWith("/setup")) await page.getByRole("button", { name: "Бежать!", exact: true }).click();
  await page.waitForFunction(() => window.__run && window.__preferences);
  const prefs = () => page.evaluate(() => {
    const { musicEnabled, musicVolume, sfxVolume } = window.__preferences.getState();
    return { musicEnabled, musicVolume, sfxVolume };
  });
  const open = () => page.getByRole("button", { name: "Громкость", exact: true }).click();
  const music = page.getByRole("slider", { name: "Громкость музыки" });
  const sfx = page.getByRole("slider", { name: "Громкость эффектов" });
  await open();
  check(await music.inputValue() === "35" && await sfx.inputValue() === "70", "Начальная громкость");
  check(await page.evaluate(() => window.__run.phase === "intro"), "Микшер не ускоряет интро");

  // Дальше проверяем управление уже в активном забеге.
  await page.evaluate(() => {
    const r = window.__run;
    for (let i = 0; i < 1200 && r.phase !== "running"; i++) r.update(1 / 60);
    window.__audioLane = r.lane;
    window.__audioInputs = [];
    r.on(event => { if (["jump", "slide", "lane"].includes(event.type)) window.__audioInputs.push(event.type); });
  });
  await music.fill("37");
  await sfx.fill("24");
  await music.press("ArrowRight");
  check(await music.inputValue() === "38", "Стрелка регулирует ползунок");
  await page.getByRole("button", { name: "Выключить музыку", exact: true }).click();
  check(await music.inputValue() === "0" && !(await prefs()).musicEnabled, "Отключение музыки");
  await page.getByRole("button", { name: "Включить музыку", exact: true }).click();
  check(await music.inputValue() === "38", "Возврат громкости музыки");
  await page.getByRole("button", { name: "Выключить эффекты", exact: true }).click();
  check((await prefs()).sfxVolume === 0, "Отключение эффектов");
  await page.getByRole("button", { name: "Включить эффекты", exact: true }).press("Space");
  check(await sfx.inputValue() === "24", "Возврат громкости эффектов");
  await music.fill("0");
  await page.getByRole("button", { name: "Включить музыку", exact: true }).click();
  check(await music.inputValue() === "38", "Возврат музыки после нуля на ползунке");
  await sfx.fill("0");
  await page.getByRole("button", { name: "Включить эффекты", exact: true }).click();
  check(await sfx.inputValue() === "24", "Возврат эффектов после нуля на ползунке");
  await music.press("Escape");
  check(await page.getByRole("slider").count() === 0, "Escape закрывает панель");
  check(await page.evaluate(() => window.__run.phase === "running" && window.__run.lane === window.__audioLane && !window.__audioInputs.length),
    "Клавиши микшера не управляют бегуном и не ставят паузу");
  await page.keyboard.press(await page.evaluate(() => window.__run.lane > 0 ? "ArrowLeft" : "ArrowRight"));
  check(await page.evaluate(() => window.__audioInputs.includes("lane")), "После закрытия панели клавиатура сразу управляет бегуном");
  await open();
  await page.mouse.click(600, 750);
  check(await page.getByRole("slider").count() === 0, "Клик снаружи закрывает панель");
  await open();
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  check(await page.getByRole("dialog", { name: "Пауза", exact: true }).isVisible(), "Пауза рядом с микшером работает");
  await page.getByRole("button", { name: "Продолжить", exact: true }).click();
  await open();
  await page.screenshot({ path: "../output/playwright/audio-controls-desktop.png" });

  // Настройки сохраняются между загрузками страницы.
  await page.reload();
  await page.waitForFunction(() => window.__run && window.__preferences);
  check(JSON.stringify(await prefs()) === JSON.stringify({ musicEnabled: true, musicVolume: 0.38, sfxVolume: 0.24 }), "Сохранение настроек");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Выключить музыку", exact: true }).click();
  check(!(await prefs()).musicEnabled && (await prefs()).sfxVolume === 0.24, "На телефоне кнопка отключает только музыку");
  check(await page.getByRole("slider").count() === 0, "На телефоне нет панели");
  await page.getByRole("button", { name: "Включить музыку", exact: true }).click();
  check((await prefs()).musicEnabled, "Повторное нажатие включает музыку");
  await page.screenshot({ path: "../output/playwright/audio-controls-mobile.png" });
  check(!errors.length, errors.join("\n"));
  return { desktop: "две громкости, mute/restore, клавиши, закрытие, пауза, сохранение", mobile: "кнопка музыки", errors };
}
