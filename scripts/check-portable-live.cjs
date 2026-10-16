// Запускает сам portable-архив, а не win-unpacked. Расходует два запроса подписок.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { chromium } = require("../build/workspace/frontend/node_modules/playwright");
const root = path.resolve(__dirname, "..");
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "Study Surfers portable приёмка "));
  const port = await freePort(), debugPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(path.join(root, "release/Study-Surfers-0.1.0-Portable-x64.exe"), [`--remote-debugging-port=${debugPort}`], {
    cwd: temp, windowsHide: true, stdio: "ignore", env: { ...process.env,
      SS_PORT: String(port), SS_DATA_DIR: path.join(temp, "data"), SS_USER_DATA_DIR: path.join(temp, "profile"),
    },
  });
  let browser;
  try {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(origin + "/api/health")).ok) break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    const page = browser.contexts()[0].pages()[0];
    await page.getByRole("heading", { name: "Повторение на бегу" }).waitFor();
    const setup = await (await fetch(origin + "/api/settings/ai/mcp")).json();
    assert.ok(setup.command.startsWith(path.join(temp, "profile", "runtime")), setup.command);
    assert.equal(setup.args[0], "--mcp");
    assert.ok(fs.existsSync(setup.command));
    const accounts = await (await fetch(origin + "/api/settings/ai/subscriptions")).json();
    assert.ok(accounts.every(account => account.status === "ready"));
    const results = [];
    for (const kind of ["codex", "claude"]) {
      const response = await fetch(`${origin}/api/settings/ai/subscriptions/${kind}/connect`, { method: "POST" });
      const settings = await response.json();
      assert.ok(response.ok, JSON.stringify(settings));
      const provider = settings.providers.find(p => p.executor_kind === kind);
      const model = kind === "codex" ? "gpt-6.1-sol" : "haiku";
      const test = await fetch(`${origin}/api/settings/ai/providers/${provider.id}/models/test`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model_id: model }),
      });
      const answer = await test.json();
      assert.equal(answer.status, "answered", JSON.stringify(answer));
      results.push({ ...answer, subscription: kind, requested_model: model });
      console.log(`Portable archive ${kind}: answered in ${answer.duration_ms} ms`);
    }
    const output = path.join(root, "output/desktop-ai-live");
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "portable.png") });
    fs.writeFileSync(path.join(output, "portable.json"), JSON.stringify({ executable: child.spawnfile, persistent_mcp_runtime: true, results }, null, 2));
    const session = await browser.newBrowserCDPSession();
    session.send("Browser.close").catch(() => {});
    await new Promise(resolve => setTimeout(resolve, 3000));
    await assert.rejects(fetch(origin + "/api/health"));
    browser = null;
  } finally {
    if (browser) {
      const session = await browser.newBrowserCDPSession().catch(() => null);
      if (session) session.send("Browser.close").catch(() => {});
    }
    if (child.exitCode === null) {
      await new Promise(resolve => spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).once("close", resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
let finished = false;
// Незавершённый main при пустом цикле событий — провал, а не тихий выход с кодом 0.
process.on("beforeExit", () => { if (!finished) { console.error("Проверка оборвалась: main не завершился."); process.exitCode = 1; } });
main().finally(() => { finished = true; }).catch(error => { console.error(error); process.exitCode = 1; });
