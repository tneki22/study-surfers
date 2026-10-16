// Техническая проверка синтеза в OfflineAudioContext, без звука на колонки.
async (page) => {
  await page.goto("http://127.0.0.1:5180/");
  return await page.evaluate(async () => {
    const { GameAudio } = await import("/src/game/audio/synth.ts");
    const result = [];
    for (const kind of ["jetpack", "gravity-shoes", "magnet", "phase", "shield", "pulse"]) {
      const ctx = new OfflineAudioContext(2, 62400, 48000);
      const native = window.AudioContext;
      let clock = 0, sound;
      Object.defineProperty(ctx, "currentTime", { get: () => clock });
      ctx.close = () => Promise.resolve();
      // Подменяем только создание контекста, синтез и маршрутизация — игровые.
      try { window.AudioContext = function () { return ctx; }; sound = new GameAudio(); }
      finally { window.AudioContext = native; }
      let peak = 0, sum = 0, count = 0;
      if (kind === "pulse") sound.shieldPulse(); else { sound.modifier(kind, "pickup"); sound.modifierMotion(kind, false); }
      clock = 0.6;
      if (kind !== "pulse") sound.modifier(kind, "end");
      sound.modifierMotion(null, false);
      const rendered = await ctx.startRendering();
      for (const sample of rendered.getChannelData(0)) { peak = Math.max(peak, Math.abs(sample)); sum += sample * sample; count++; }
      if (peak < 0.005 || peak >= 1 || !Number.isFinite(sum)) throw new Error(`${kind}: некорректный звуковой сигнал ${peak}`);
      result.push({ kind, peak: +peak.toFixed(4), rms: +Math.sqrt(sum / count).toFixed(4) });
      sound.dispose();
    }
    return result;
  });
}
