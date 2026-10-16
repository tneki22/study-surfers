// Проверка самого самораспаковывающегося Portable EXE с чистыми временными данными.
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
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function until(check, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { return await check(); } catch (error) { last = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw last;
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "Study Surfers portable проверка "));
  const port = await freePort();
  const debugPort = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const version = require("../package.json").version;
  let browser;
  let spawnError;
  const child = spawn(path.join(root, `release/Study-Surfers-${version}-Portable-x64.exe`),
    [`--remote-debugging-port=${debugPort}`, "--remote-debugging-address=127.0.0.1"], {
      cwd: temp, windowsHide: true, stdio: "ignore",
      env: { ...process.env, PATH: process.env.SystemRoot || "C:\\Windows", PYTHONPATH: "",
        SS_PORT: String(port), SS_DATA_DIR: path.join(temp, "data"),
        SS_USER_DATA_DIR: path.join(temp, "profile"), SS_SEED_DEMO: "1" },
    });
  child.on("error", (error) => { spawnError = error; });
  try {
    await until(async () => {
      if (spawnError) throw spawnError;
      const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) });
      assert.equal((await response.json()).status, "ok");
    });
    browser = await until(() => chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, { timeout: 3000 }));
    const page = browser.contexts()[0].pages()[0];
    await page.getByRole("heading", { name: "Повторение на бегу" }).waitFor();
    const config = await (await fetch(`${origin}/api/settings/ai/mcp`)).json();
    assert.ok(config.command.startsWith(path.join(temp, "profile", "runtime")), config.command);
    assert.ok(fs.existsSync(config.command));
    assert.equal(config.args[0], "--mcp");
    const decks = await (await fetch(`${origin}/api/decks`)).json();
    assert.equal(decks.length, 1);
    assert.equal(decks[0].source_kind, "demo");
    await page.getByRole("button", { name: "Бежать", exact: true }).first().click();
    await page.getByRole("button", { name: "Бежать!", exact: true }).click();
    await page.locator("canvas").waitFor({ timeout: 30_000 });
    await page.locator(".lane-card").first().waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Пауза", exact: true }).click();
    await page.getByRole("dialog", { name: "Пауза", exact: true }).waitFor();
    const output = path.join(root, "output/desktop-smoke");
    fs.mkdirSync(output, { recursive: true });
    await page.screenshot({ path: path.join(output, "portable.png") });
    const session = await browser.newBrowserCDPSession();
    // Ответ на Browser.close не приходит: соединение рвётся раньше. Если его ждать,
    // у Node не остаётся активных дескрипторов и он молча выходит с кодом 0.
    session.send("Browser.close").catch(() => {});
    browser = null;
    await until(async () => {
      let reachable = false;
      try { reachable = (await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1000) })).ok; }
      catch { /* Сервер завершён. */ }
      assert.equal(reachable, false);
    }, 20_000);
    console.log("Portable EXE: самораспаковка, чистый профиль, демо, 3D, постоянный MCP и завершение — OK.");
  } finally {
    if (browser) {
      const session = await browser.newBrowserCDPSession().catch(() => null);
      if (session) session.send("Browser.close").catch(() => {});
    }
    if (child.exitCode === null) {
      await new Promise((resolve) => spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"],
        { windowsHide: true, stdio: "ignore" }).once("close", resolve));
    }
    // Распакованное приложение Portable освобождает профиль с задержкой после выхода сервера.
    await until(() => fs.rmSync(temp, { recursive: true, force: true }), 60_000)
      .catch((error) => console.warn(`Не удалось удалить ${temp}: ${error.message}`));
  }
}
let finished = false;
// Незавершённый main при пустом цикле событий — провал, а не тихий выход с кодом 0.
process.on("beforeExit", () => { if (!finished) { console.error("Проверка оборвалась: main не завершился."); process.exitCode = 1; } });
main().finally(() => { finished = true; }).catch((error) => { console.error(error); process.exitCode = 1; });
