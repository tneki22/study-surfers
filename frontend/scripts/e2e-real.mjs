// Сквозная проверка на настоящем бэкенде и локальной модели:
//   node scripts/e2e-real.mjs <outDir> [модель Ollama]
// Нужны: uvicorn на 8765 (лучше с отдельным SS_DATA_DIR), `npm run dev` на 5180
// и запущенный Ollama. Сценарий проходит путь пользователя через интерфейс:
// подключение Ollama в «Параметрах» → вставка вопросов с ответами → карточки
// от модели → забег автопилотом → результаты → забег сохранён на сервере.
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const [outDir = "e2e", model = "qwen3:8b"] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const BASE = "http://127.0.0.1:5180";

const MATERIAL = `Вопросы к экзамену по теории вероятностей

1. Что такое условная вероятность?
Ответ: Условная вероятность события A при условии B — это P(A|B) = P(AB) / P(B), где P(B) > 0. Она показывает вероятность A, если известно, что B произошло.

2. Сформулируйте формулу полной вероятности.
Ответ: Если события H1, …, Hn образуют полную группу попарно несовместных событий, то P(A) = Σ P(Hi)·P(A|Hi). Формула раскладывает вероятность события по гипотезам.

3. Что утверждает формула Байеса?
Ответ: Формула Байеса пересчитывает вероятность гипотезы после опыта: P(Hi|A) = P(Hi)·P(A|Hi) / P(A). Знаменатель P(A) вычисляют по формуле полной вероятности.

4. Чему равно математическое ожидание суммы случайных величин?
Ответ: Математическое ожидание суммы равно сумме математических ожиданий: M(X+Y) = M(X) + M(Y). Это верно всегда, независимость не нужна.`;

const browser = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on("pageerror", (error) => errors.push(String(error)));
page.on("console", (message) => {
  if (message.type() === "error" && !/favicon/.test(message.text())) errors.push(message.text());
});
await page.addInitScript(() => {
  localStorage.setItem("ss:preferences", JSON.stringify({
    state: { quality: "low", musicVolume: 0, sfxVolume: 0, musicEnabled: false, reducedMotion: true, keyHints: true, character: "rogue-hooded" },
    version: 1,
  }));
  window.__manualClock = true;
});
const shot = (name) => page.screenshot({ path: join(outDir, `${name}.png`), timeout: 120000 });
const step = (text) => console.log(`[${new Date().toLocaleTimeString("ru-RU")}] ${text}`);

// 1. Подключение Ollama через «Параметры → ИИ».
await page.goto(`${BASE}/settings`);
await page.getByText("Модель для карточек не выбрана").waitFor({ timeout: 30000 });
await page.getByRole("radio", { name: "Ollama" }).or(page.getByRole("tab", { name: "Ollama" })).first().click();
await page.getByRole("button", { name: "Подключить" }).click();
await page.getByRole("button", { name: /Выбрать модель из каталога/ }).click();
const row = page.locator(".catalog-list li").filter({ has: page.getByText(model, { exact: true }) }).first();
await row.waitFor({ timeout: 30000 }).catch(async (error) => {
  await shot("00-catalog-failed");
  throw error;
});
await row.getByRole("button", { name: "Добавить" }).click();
await page.getByText("Карточки делает").waitFor({ timeout: 15000 });
step(`модель подключена: ${await page.locator(".ai-status p").innerText()}`);
await shot("01-ai-settings");

// 2. Вставляем вопросы с ответами и создаём колоду.
await page.goto(BASE);
await page.getByRole("button", { name: /или вставь текст/ }).click();
await page.locator("textarea.paste-area").fill(MATERIAL);
await page.getByRole("button", { name: /Создать и играть/ }).click();
await page.waitForURL(/\/import\//, { timeout: 30000 });
step("импорт запущен");
const started = Date.now();
let lastLabel = "";
for (;;) {
  const text = await page.locator(".import-progress").innerText();
  const label = text.split("\n").slice(0, 8).join(" | ");
  if (label !== lastLabel) {
    step(label.slice(0, 160));
    lastLabel = label;
  }
  if (/Колода готова|Подготовка остановлена/.test(text)) break;
  if (Date.now() - started > 15 * 60 * 1000) throw new Error("генерация дольше 15 минут");
  await page.waitForTimeout(3000);
}
await shot("02-import-done");
const deckId = new URL(page.url()).searchParams.get("deck");
const items = await (await fetch(`http://127.0.0.1:8765/api/decks/${deckId}/items`)).json();
step(`карточек: ${items.items.length}`);
for (const item of items.items.slice(0, 6)) {
  step(`  • ${item.prompt} → ${item.correct} [${item.source}] (${item.distractors.length} неверных)`);
}

// 3. Забег на этих карточках: автопилот выбирает случайный трек и проходит препятствия.
await page.getByRole("button", { name: /Бежать!|Начать забег сейчас/ }).click();
await page.waitForFunction(() => window.__run, null, { timeout: 60000 });
await page.waitForTimeout(1500);
const phase = await page.evaluate(async () => {
  const run = window.__run;
  for (let t = 0; t < 400; t += 1 / 30) {
    if (run.phase === "finished" || run.phase === "gameover") return run.phase;
    const next = run.obstacles.find((o) => !o.resolved);
    if (next) {
      const ahead = next.distance - run.distance;
      const trigger = { hurdle: 4, bar: 2.6, wagons: 3.4 }[next.kind];
      if (ahead <= trigger && !run.airborne && run.slideProgress() < 0) next.kind === "bar" ? run.slide() : run.jump();
    }
    if (run.gate && run.gate.distance - run.distance > 30 && Math.random() < 0.01) run.moveLane(Math.random() < 0.5 ? -1 : 1);
    run.update(1 / 30);
  }
  return run.phase;
});
step(`забег закончился: ${phase}`);
await page.evaluate(() => {
  for (let t = 0; t < 4; t += 1 / 30) window.__run.update(1 / 30);
});
await page.waitForSelector(".results-card", { timeout: 60000 });
await page.waitForTimeout(1500);
await shot("03-results");
const runs = await (await fetch(`http://127.0.0.1:8765/api/decks/${deckId}/runs`)).json();
step(`забегов на сервере: ${runs.length}; последний: ${runs[0] ? `${runs[0].score} очков, верно ${runs[0].correct_count}, ошибок ${runs[0].wrong_count}` : "—"}`);

// 4. Колода: статистика и правка карточки.
await page.goto(`${BASE}/decks/${deckId}`);
await page.locator(".item-row").first().waitFor();
await page.locator(".item-row-main").first().click();
await shot("04-deck");

console.log("errors:", errors.length ? errors.join("\n") : "нет");
await browser.close();
