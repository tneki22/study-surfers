// Ручная приёмка реальных подписок. Расходует их лимиты; личные данные не меняет.
// node scripts/check-ai-live.cjs [--source | --portable-runtime] [--kind=codex|claude]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { _electron } = require("../build/workspace/frontend/node_modules/playwright");
const { BackendProcess } = require("../desktop/runtime.cjs");
const root = path.resolve(__dirname, "..");
const output = path.join(root, "output/desktop-ai-live");
fs.mkdirSync(output, { recursive: true });

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "Study Surfers живая проверка "));
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const source = process.argv.includes("--source");
  const portable = process.argv.includes("--portable-runtime");
  const hostOnly = process.argv.includes("--host-only");
  const mcpOnly = process.argv.includes("--mcp-only") || hostOnly;
  const report = { origin, mode: (source ? "source" : portable ? "portable-runtime" : "exe") + (hostOnly ? "-host" : mcpOnly ? "-mcp" : ""), checks: [] };
  let app;
  try {
    app = await _electron.launch({
      executablePath: source ? path.join(root, "node_modules/electron/dist/electron.exe") : path.join(root, "release/win-unpacked/Study Surfers.exe"),
      args: source ? [root] : [], cwd: root, timeout: 60_000,
      env: { ...process.env, SS_PORT: String(port), SS_DATA_DIR: path.join(temp, "data"),
        SS_USER_DATA_DIR: path.join(temp, "profile"), SS_SEED_DEMO: "1",
        ...(portable ? { PORTABLE_EXECUTABLE_DIR: path.join(temp, "portable") } : {}),
      },
    });
    const page = await app.firstWindow();
    const pageErrors = [];
    page.on("pageerror", e => pageErrors.push(e.message));
    await page.waitForURL(`${origin}/`);
    async function api(route, method = "GET", body) {
      return page.evaluate(async ({ route, method, body }) => {
        const response = await fetch(route, { method, ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
        const result = await response.json();
        if (!response.ok) throw new Error(`${route}: ${response.status} ${JSON.stringify(result)}`);
        return result;
      }, { route, method, body });
    }
    async function waitJob(id) {
      const deadline = Date.now() + 600_000;
      let previous;
      while (Date.now() < deadline) {
        const job = await api(`/api/jobs/${id}`);
        const progress = `${job.state} ${job.ready_items} cards`;
        if (progress !== previous) { console.log(progress); previous = progress; }
        if (["done", "failed", "cancelled", "interrupted", "awaiting_confirm"].includes(job.state)) {
          assert.equal(job.state, "done", JSON.stringify(job));
          assert.equal(job.failed_questions, 0, JSON.stringify(job));
          assert.ok(job.ready_items >= 1);
          assert.equal(job.usage.cost_usd, null);
          return job;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw new Error(`Job ${id} timeout`);
    }
    const accounts = await api("/api/settings/ai/subscriptions");
    assert.ok(accounts.every(a => a.status === "ready"), JSON.stringify(accounts));
    async function runMcp(kind, model) {
      return new Promise((resolve, reject) => {
        const child = spawn(path.join(root, "backend/.venv/Scripts/python.exe"), [path.join(root, "scripts/check-mcp-live.py"), origin, kind, model, ...(hostOnly ? ["--host-only"] : [])], { cwd: root, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } });
        let stdout = "", stderr = "";
        child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
        child.once("error", reject);
        child.once("close", code => code ? reject(new Error(`MCP ${code}: ${stdout}\n${stderr}`)) : resolve(JSON.parse(stdout.trim().split(/\r?\n/).at(-1))));
      });
    }
    const onlyKind = process.argv.find(arg => arg.startsWith("--kind="))?.slice(7);
    for (const kind of ["codex", "claude"].filter(k => !onlyKind || k === onlyKind)) {
      console.log(`LIVE ${report.mode} ${kind}`);
      await page.goto(`${origin}/settings`);
      const panel = page.locator(".subscription-client").filter({ hasText: kind === "codex" ? "Подписка ChatGPT" : "Подписка Claude" });
      await panel.getByRole("button", { name: "Подключить подписку" }).click();
      await panel.getByRole("button", { name: "Обновить модели" }).waitFor({ timeout: 60_000 });
      const settings = await api("/api/settings/ai");
      const provider = settings.providers.find(p => p.executor_kind === kind);
      const model = kind === "codex" ? "gpt-6.1-sol" : "haiku";
      const row = page.locator(".model-row").filter({ hasText: settings.models.find(m => m.provider_id === provider.id && m.model_id === model).display_name }).first();
      await row.getByTitle("Сделать моделью по умолчанию").click();
      const testResponse = page.waitForResponse(r => r.url().endsWith("/models/test") && r.request().method() === "POST", { timeout: 180_000 });
      await row.getByRole("button", { name: "Проверить", exact: true }).click();
      const test = await (await testResponse).json();
      assert.equal(test.status, "answered", JSON.stringify(test));
      if (mcpOnly) {
        report.checks.push({ kind, model, mcp: await runMcp(kind, model) });
        console.log(`${kind}: MCP OK`);
        continue;
      }
      if (kind === "claude") {
        const offModel = settings.models.find(m => m.provider_id === provider.id && m.reasoning?.efforts?.includes("none"));
        if (offModel) {
          const offTest = await api(`/api/settings/ai/providers/${provider.id}/models/test`, "POST", { model_id: offModel.model_id });
          assert.equal(offTest.status, "answered", JSON.stringify(offTest));
          report.thinking_off_test = { model: offModel.model_id, ...offTest };
        }
      }
      const started = Date.now();
      await page.goto(origin);
      await page.getByRole("button", { name: "или вставь текст" }).click();
      await page.getByPlaceholder("Вставь сюда список вопросов, ответы или конспект").fill(
        "Первичный ключ однозначно определяет строку таблицы: он уникален и не допускает NULL. " +
        "Индекс ускоряет поиск строк по столбцам, но требует дополнительного места и замедляет запись. " +
        "Атомарность транзакции означает выполнение всех её изменений целиком или полную отмену. " +
        "Эти три понятия относятся к реляционным базам данных."
      );
      await page.getByRole("tablist", { name: "Карточек на вопрос" }).getByRole("tab", { name: "1", exact: true }).click();
      const importResponse = page.waitForResponse(r => r.url().endsWith("/api/imports/quick") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Создать и играть" }).click();
      const ids = await (await importResponse).json();
      assert.ok(ids.job_id, JSON.stringify(ids));
      const job = await waitJob(ids.job_id);
      const importSeconds = (Date.now() - started) / 1000;
      const items = (await api(`/api/decks/${ids.deck_id}/items`)).items;
      const deck = await api(`/api/decks/${ids.deck_id}`);
      assert.ok(items.every(i => i.correct && i.distractors.filter(d => d.kind === "far").length >= 2 && i.distractors.filter(d => d.kind === "near").length >= 3));
      assert.deepEqual(items.map(i => i.seq), items.map((_, n) => n + 1));
      await page.goto(`${origin}/decks/${ids.deck_id}`);
      await page.getByText(items[0].prompt, { exact: true }).first().waitFor();
      await page.screenshot({ path: path.join(output, `${report.mode}-${kind}.png`), fullPage: true });
      const regenerated = await api(`/api/items/${items[0].id}/regenerate`, "POST", { mode: "distractors" });
      assert.equal(regenerated.prompt, items[0].prompt);
      // Отдельный путь: список вопросов + ответы, загруженные через файловый input.
      const filesStarted = Date.now();
      await page.goto(origin);
      await page.getByRole("region", { name: "Закинь вопросы, ответы или конспект. И в забег!" }).locator('input[type="file"]').setInputFiles([
        { name: "program.md", mimeType: "text/markdown", buffer: Buffer.from("1. Назначение первичного ключа\n2. Назначение индекса базы данных") },
        { name: "answers.md", mimeType: "text/markdown", buffer: Buffer.from("1. Назначение первичного ключа\nПервичный ключ однозначно определяет строку таблицы. Он уникален и не допускает NULL.\n2. Назначение индекса базы данных\nИндекс ускоряет поиск строк, но требует дополнительного места и замедляет запись.") },
      ]);
      await page.getByRole("tablist", { name: "Карточек на вопрос" }).getByRole("tab", { name: "1", exact: true }).click();
      const filesResponse = page.waitForResponse(r => r.url().endsWith("/api/imports/quick") && r.request().method() === "POST");
      await page.getByRole("button", { name: "Создать и играть" }).click();
      const filesIds = await (await filesResponse).json();
      const filesJob = await waitJob(filesIds.job_id);
      const filesSeconds = (Date.now() - filesStarted) / 1000;
      const fileItems = (await api(`/api/decks/${filesIds.deck_id}/items`)).items;
      assert.equal(fileItems.length, 2);
      assert.ok(fileItems.every(i => i.source === "user_docs" && i.evidence_quote));
      const check = { kind, model, model_test: test, import_seconds: importSeconds, files_seconds: filesSeconds, job, title: deck.title, items, files_job: filesJob, file_items: fileItems, regeneration: "ok" };
      report.checks.push(check);
      check.mcp = await runMcp(kind, model);
      check.seconds = (Date.now() - started) / 1000;
      fs.writeFileSync(path.join(output, `${report.mode}.json`), JSON.stringify(report, null, 2));
      console.log(`${kind}: import, regeneration, MCP OK`);
    }
    assert.deepEqual(pageErrors, []);
    report.page_errors = pageErrors;
    const setupServer = new BackendProcess({
      command: source ? path.join(root, "backend/.venv/Scripts/python.exe") : path.join(root, "release/win-unpacked/resources/backend/study-surfers-backend.exe"),
      args: [...(source ? [path.join(root, "backend/desktop_server.py")] : []), "--port", "0"],
      options: { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: {
        ...process.env, SS_DATA_DIR: path.join(temp, "setup-data"),
        CODEX_HOME: path.join(temp, "codex-config"), CLAUDE_CONFIG_DIR: path.join(temp, "claude-config"),
      } },
    });
    try {
      fs.mkdirSync(path.join(temp, "codex-config"), { recursive: true });
      fs.mkdirSync(path.join(temp, "claude-config"), { recursive: true });
      const setupOrigin = await setupServer.start();
      report.mcp_install = {};
      for (const kind of ["codex", "claude"]) {
        const statuses = [];
        for (let i = 0; i < 2; i++) {
          const response = await fetch(`${setupOrigin}/api/settings/ai/mcp/install/${kind}`, { method: "POST" });
          const result = await response.json();
          assert.ok(response.ok, JSON.stringify(result));
          statuses.push(result.status);
        }
        assert.deepEqual(statuses, ["installed", "already_installed"]);
        report.mcp_install[kind] = statuses;
      }
    } finally { await setupServer.stop(); }
  } finally {
    if (app) await app.close().catch(() => {});
    fs.writeFileSync(path.join(output, `${report.mode}.json`), JSON.stringify(report, null, 2));
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
