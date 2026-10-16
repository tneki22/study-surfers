const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { _electron } = require("../build/workspace/frontend/node_modules/playwright");

const root = path.resolve(__dirname, "..");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "Study Surfers окно "));
  const output = path.join(root, "output/desktop-smoke");
  fs.mkdirSync(output, { recursive: true });
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  let application;
  const errors = [];
  const portable = process.argv.includes("--portable-runtime");
  try {
    application = await _electron.launch({
      executablePath: path.join(root, "release/win-unpacked/Study Surfers.exe"),
      cwd: temp,
      chromiumSandbox: true,
      timeout: 60_000,
      env: {
        ...process.env,
        PATH: process.env.SystemRoot || "C:\\Windows",
        SS_PORT: String(port),
        SS_DATA_DIR: path.join(temp, "data"),
        SS_USER_DATA_DIR: path.join(temp, "profile"),
        SS_SEED_DEMO: "1",
        ...(portable ? { PORTABLE_EXECUTABLE_DIR: path.join(temp, "portable") } : {}),
      },
    });
    const page = await application.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.waitForURL(`${origin}/`);
    await page.getByRole("heading", { name: "Повторение на бегу" }).waitFor();
    await page.getByRole("button", { name: "Бежать", exact: true }).first().waitFor();
    assert.deepEqual(await page.evaluate(() => [typeof window.require, typeof window.process]), ["undefined", "undefined"]);
    const preferences = await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences());
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.nodeIntegration, false);
    const mcp = await page.evaluate(async () => (await fetch("/api/settings/ai/mcp")).json());
    if (portable) assert.ok(mcp.command.startsWith(path.join(temp, "profile", "runtime")), mcp.command);
    assert.equal(mcp.args[0], "--mcp");
    await page.screenshot({ path: path.join(output, "home.png") });
    await page.getByRole("button", { name: "Бежать", exact: true }).first().click();
    // Диалог настройки запускается существующей кнопкой, а не обходом состояния игры.
    await page.getByRole("button", { name: "Бежать!", exact: true }).click();
    await page.locator("canvas").first().waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const canvas = document.querySelector("canvas");
      return canvas && canvas.width > 0 && canvas.height > 0;
    });
    await page.locator(".play-loading").waitFor({ state: "hidden", timeout: 30_000 });
    await page.locator(".lane-card").first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(output, "game.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Пауза", exact: true }).click();
    await page.getByRole("dialog", { name: "Пауза", exact: true }).waitFor();
    await page.getByRole("button", { name: "Выйти в меню", exact: true }).click();
    await page.getByRole("heading", { name: "Повторение на бегу" }).waitFor();
    await page.getByRole("button", { name: "Бежать", exact: true }).first().click();
    await page.getByText("Ночной город", { exact: true }).click();
    await page.locator('input[name="world"][value="night-maglev"]').isChecked().then((checked) => assert.ok(checked));
    await page.getByRole("button", { name: "Бежать!", exact: true }).click();
    await page.locator('.play-screen[data-world="night-maglev"] canvas').waitFor({ timeout: 30_000 });
    await page.locator(".play-loading").waitFor({ state: "hidden", timeout: 30_000 });
    await page.locator(".lane-card").first().waitFor({ timeout: 30_000 });
    await page.screenshot({ path: path.join(output, "game-night.png"), animations: "disabled" });
    await page.getByRole("button", { name: "Пауза", exact: true }).click();
    await page.getByRole("dialog", { name: "Пауза", exact: true }).waitFor();
    assert.deepEqual(errors, [], errors.join("\n"));
    await application.close();
    application = null;
    await assert.rejects(fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(2000) }), /fetch failed/);
    console.log(`Electron EXE${portable ? " (portable runtime)" : ""}: окно, интерфейс, обе 3D-сцены, изоляция и завершение бэкенда — OK.`);
  } finally {
    if (application) await application.close().catch(() => {});
    // Chromium может освобождать файлы профиля чуть позже выхода процесса.
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
