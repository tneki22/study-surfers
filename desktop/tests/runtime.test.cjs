const assert = require("node:assert/strict");
const { test } = require("node:test");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { BackendProcess, allowedExternalUrl, contentSecurityPolicy, launchOptions, persistentPortableResources } = require("../runtime.cjs");

test("EXE запускает собственный бэкенд, пути с пробелами не проходят через shell", () => {
  const result = launchOptions({ packaged: true, resourcesPath: "C:\\Приложения\\Study Surfers\\resources", dataDir: "C:\\Данные\\data" });
  assert.equal(path.basename(result.command), "study-surfers-backend.exe");
  assert.deepEqual(result.args, []);
  assert.equal(result.options.shell, undefined);
  assert.equal(result.options.windowsHide, true);
  assert.equal(result.options.env.SS_DATA_DIR, "C:\\Данные\\data");
});

test("Внешние ссылки допускают HTTPS и локальный OAuth", () => {
  for (const url of ["https://example.com/login", "http://localhost:1455/auth", "http://127.0.0.1:5180"]) assert.equal(allowedExternalUrl(url), true);
  for (const url of ["file:///C:/Windows/cmd.exe", "javascript:alert(1)", "data:text/html,x", "http://example.com", "https://user:secret@example.com", "broken"]) assert.equal(allowedExternalUrl(url), false);
});

test("CSP разрешает скрипт темы по хэшу и не даёт eval или Node в интерфейс", () => {
  const script = "localStorage.getItem('ss:theme')";
  const csp = contentSecurityPolicy(`<script>${script}</script><script src="/app.js"></script>`);
  assert.ok(csp.includes(`'sha256-${createHash("sha256").update(script).digest("base64")}'`));
  assert.ok(csp.includes("connect-src 'self' blob:"));
  assert.ok(csp.includes("'wasm-unsafe-eval'"));
  assert.ok(!csp.includes("'unsafe-eval'"));
  assert.ok(!csp.match(/script-src[^;]*unsafe-inline/));
});

function fakeBackend(source) {
  return new BackendProcess({ command: process.execPath, args: ["-e", source], options: { stdio: ["pipe", "pipe", "pipe"], windowsHide: true } });
}

test("Закрытие pipe останавливает только дочерний процесс", async () => {
  const backend = fakeBackend("console.log('SS_DESKTOP_READY {\"port\":18765}'); process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
  try { assert.equal(await backend.start(), "http://127.0.0.1:18765"); }
  finally { await backend.stop(); }
  assert.equal(backend.child.exitCode, 0);
});

test("Ошибка запуска сохраняет причину и не подключается к постороннему серверу", async () => {
  const backend = fakeBackend("console.error('port already in use'); process.exit(1)");
  await assert.rejects(backend.start(), /port already in use/);
  await backend.stop();
});

test("Зависший запуск ограничен таймаутом и его можно завершить", async () => {
  const backend = fakeBackend("process.stdin.resume(); process.stdin.on('end', () => process.exit(0));");
  await assert.rejects(backend.start(100), /не запустился/);
  await backend.stop();
});

test("Portable сохраняет путь MCP при перезапуске и подхватывает новые библиотеки", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "study-surfers-runtime-"));
  try {
    const first = path.join(temp, "temporary-one");
    fs.mkdirSync(path.join(first, "backend/_internal"), { recursive: true });
    fs.writeFileSync(path.join(first, "backend/study-surfers-backend.exe"), "exe");
    fs.writeFileSync(path.join(first, "backend/_internal/python312.dll"), "original");
    const user = path.join(temp, "user");
    const stored = persistentPortableResources(first, user);
    const next = path.join(temp, "temporary-two");
    fs.cpSync(first, next, { recursive: true });
    assert.equal(persistentPortableResources(next, user), stored);
    fs.rmSync(first, { recursive: true });
    assert.equal(fs.readFileSync(path.join(stored, "backend/study-surfers-backend.exe"), "utf8"), "exe");
    fs.writeFileSync(path.join(next, "backend/_internal/python312.dll"), "updated");
    const updated = persistentPortableResources(next, user);
    assert.notEqual(updated, stored);
    assert.equal(fs.readFileSync(path.join(updated, "backend/_internal/python312.dll"), "utf8"), "updated");
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
