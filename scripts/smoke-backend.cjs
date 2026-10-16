// Проверяет именно замороженный EXE без Python/Node в PATH дочернего процесса.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const { BackendProcess } = require("../desktop/runtime.cjs");

const root = path.resolve(__dirname, "..");
const executable = path.resolve(process.argv[2] || path.join(root, "build/backend/study-surfers-backend/study-surfers-backend.exe"));

async function main() {
  function checkResources(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) checkResources(file);
      else assert.ok(!/^(?:installation\.secret|mcp\.token|\.env(?:\..*)?)$|\.(?:sqlite(?:-wal|-shm)?|ssdeck\.json)$/i.test(entry.name)
        || (entry.name === "demo-deck.ssdeck.json" && path.basename(directory) === "fixtures"), `Личный файл в ресурсах EXE: ${file}`);
    }
  }
  checkResources(path.dirname(executable));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "Study Surfers проверка "));
  const env = {
    ...process.env,
    PATH: process.env.SystemRoot || "C:\\Windows",
    PYTHONPATH: "",
    SS_DATA_DIR: temp,
    SS_SEED_DEMO: "1",
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
  };
  const server = () => new BackendProcess({
    command: executable, args: ["--port", "0"],
    options: { cwd: temp, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
  });
  let receivedToken;
  const modelServer = http.createServer((request, response) => {
    receivedToken = request.headers.authorization;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ object: "list", data: [{ id: "release-test", object: "model" }] }));
  });
  await new Promise((resolve, reject) => { modelServer.once("error", reject); modelServer.listen(0, "127.0.0.1", resolve); });
  let backend = server();
  try {
    let origin = await backend.start();
    async function json(route, options) {
      const response = await fetch(origin + route, { ...options, signal: AbortSignal.timeout(15_000) });
      assert.ok(response.ok, `${route}: ${response.status} ${await response.clone().text()}`);
      return response.json();
    }
    assert.equal((await json("/api/health")).status, "ok");
    assert.equal((await json("/api/health", { headers: { Origin: origin } })).status, "ok");
    // fetch в Node 24 заменяет Host адресом URL; http.get отправляет настоящий
    // подменённый заголовок и проверяет именно границу DNS rebinding.
    await new Promise((resolve, reject) => {
      const request = http.get(origin + "/api/decks", { headers: { Host: "attacker.example" } }, (response) => {
        let data = "";
        response.on("data", (chunk) => { data += chunk; });
        response.on("end", () => {
          try {
            assert.equal(response.statusCode, 403);
            assert.equal(JSON.parse(data).code, "untrusted_host");
            resolve();
          } catch (error) { reject(error); }
        });
      });
      request.setTimeout(5000, () => request.destroy(new Error("Host check timed out")));
      request.on("error", reject);
    });
    const blocked = await fetch(origin + "/api/imports/quick", {
      method: "POST", headers: { Origin: "https://attacker.example" }, body: new URLSearchParams({ text: "1. Вопрос?" }),
    });
    assert.equal(blocked.status, 403);
    assert.equal((await blocked.json()).code, "request_origin_forbidden");
    const decks = await json("/api/decks");
    const demo = decks.find((deck) => deck.source_kind === "demo");
    assert.ok(demo?.item_count >= 8, "Демо-колода должна быть внутри EXE");
    const page = await (await fetch(origin)).text();
    assert.match(page, /id="root"/);
    const assets = [...page.matchAll(/(?:src|href)="(\/[^"#]+)"/g)];
    for (const [, asset] of assets) {
      const response = await fetch(origin + asset);
      assert.ok(response.ok, `Ресурс ${asset} должен загружаться`);
      assert.ok(!response.headers.get("content-type")?.includes("text/html"), `${asset}: вместо ресурса пришёл HTML`);
    }
    const exported = await json(`/api/decks/${demo.id}/export`);
    assert.equal(exported.format, "study-surfers-deck");
    for (const name of ["answers.docx", "text.pdf", "questions_cp1251.txt"]) {
      const document = new FormData();
      document.append("files[]", new Blob([fs.readFileSync(path.join(root, "backend/tests/fixtures", name))]), name);
      document.append("options", "{}");
      const parsed = await json("/api/imports/quick?dry_run=true", { method: "POST", body: document });
      assert.ok(parsed.documents?.length > 0, `Парсер ${name}: ${JSON.stringify(parsed)}`);
    }
    const form = new FormData();
    form.append("file", new Blob([JSON.stringify(exported)], { type: "application/json" }), "проверка.ssdeck.json");
    const imported = await json("/api/decks/import", { method: "POST", body: form });
    assert.equal(imported.item_count, demo.item_count);
    const ai = await json("/api/settings/ai/providers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ label: "Проверка шифрования", base_url: `http://127.0.0.1:${modelServer.address().port}/v1`, api_key: "release-test-dummy-key" }),
    });
    const provider = ai.providers.find((entry) => entry.label === "Проверка шифрования");
    assert.equal(provider.has_api_key, true);
    assert.ok(!JSON.stringify(ai).includes("release-test-dummy-key"));
    assert.ok(fs.existsSync(path.join(temp, "study-surfers.sqlite")));
    const config = await json("/api/settings/ai/mcp");
    assert.equal(path.resolve(config.command), executable);
    assert.equal(config.args[0], "--mcp");
    assert.equal(config.args[config.args.indexOf("--port") + 1], new URL(origin).port);
    await smokeMcp(executable, temp, env, config.args.slice(1), true);
    await backend.stop();
    assert.equal(backend.child.exitCode, 0, backend.tail);
    backend = server();
    origin = await backend.start();
    assert.ok((await json("/api/decks")).some((deck) => deck.id === imported.id), "Данные должны пережить перезапуск EXE");
    assert.equal((await json(`/api/settings/ai/providers/${provider.id}/test`, { method: "POST" })).status, "connected");
    assert.equal(receivedToken, "Bearer release-test-dummy-key", "Ключ должен расшифровываться после перезапуска EXE");
    await backend.stop();
    await smokeMcp(executable, temp, env);
    console.log("EXE: ресурсы, API, демо, импорт/экспорт, сохранение, перезапуск, shutdown и STDIO MCP — OK.");
  } finally {
    await backend.stop();
    await new Promise((resolve) => modelServer.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function smokeMcp(command, cwd, env, args = ["--token-file", path.join(cwd, "missing.token")], running = false) {
  const child = spawn(command, ["--mcp", ...args], {
    cwd, env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  child.stdin.on("error", () => {});
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const pending = new Map();
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const value = JSON.parse(line);
      pending.get(value.id)?.(value);
    } catch { /* Логи не должны попадать в STDIO-протокол. */ }
  });
  const request = (id, method, params = {}) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`MCP ${method}: ${stderr}`)); }, 15_000);
    pending.set(id, (value) => { clearTimeout(timer); pending.delete(id); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  const closed = new Promise((resolve, reject) => { child.once("close", resolve); child.once("error", reject); });
  try {
    const init = await request(1, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "build-smoke", version: "1" } });
    assert.equal(init.result?.serverInfo.name, "Study Surfers", JSON.stringify(init));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = await request(2, "tools/list");
    assert.ok(tools.result.tools.some((tool) => tool.name === "get_next_task"));
    const status = await request(3, "tools/call", { name: "get_status", arguments: {} });
    if (running) {
      assert.equal(JSON.parse(status.result.content[0].text).status, "ok");
      const jobs = await request(4, "tools/call", { name: "list_jobs", arguments: {} });
      const jobsData = jobs.result.structuredContent || JSON.parse(jobs.result.content[0].text);
      assert.ok(Array.isArray(jobsData.result || jobsData), JSON.stringify(jobs));
    } else assert.match(JSON.stringify(status), /app_not_running/);
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 5000);
    try { await closed; } finally { clearTimeout(timer); lines.close(); }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
