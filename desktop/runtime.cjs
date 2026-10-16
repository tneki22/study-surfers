const { spawn } = require("node:child_process");
const { EventEmitter } = require("node:events");
const { createHash } = require("node:crypto");
const { createInterface } = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");

function persistentPortableResources(resourcesPath, userRoot) {
  const source = path.join(resourcesPath, "backend");
  const digest = createHash("sha256");
  function fingerprint(directory, prefix = "") {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      const relative = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) fingerprint(file, relative);
      else { digest.update(relative + "\0"); digest.update(createHash("sha256").update(fs.readFileSync(file)).digest()); }
    }
  }
  fingerprint(source);
  const runtimeRoot = path.join(userRoot, "runtime");
  const target = path.join(runtimeRoot, digest.digest("hex"));
  if (fs.existsSync(path.join(target, "backend", "study-surfers-backend.exe"))) return target;
  fs.mkdirSync(runtimeRoot, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(runtimeRoot, "unpacking-"));
  try {
    fs.cpSync(source, path.join(temporary, "backend"), { recursive: true });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
  return target;
}

function launchOptions({ packaged, resourcesPath, projectRoot, dataDir }) {
  const command = packaged
    ? path.join(resourcesPath, "backend", "study-surfers-backend.exe")
    : path.join(projectRoot, "backend", ".venv", "Scripts", "python.exe");
  const args = packaged ? [] : [path.join(projectRoot, "backend", "desktop_server.py")];
  return {
    command,
    args,
    options: {
      cwd: path.dirname(command),
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", SS_DATA_DIR: dataDir },
    },
  };
}

function allowedExternalUrl(value) {
  try {
    const url = new URL(value);
    return !url.username && !url.password && (url.protocol === "https:" ||
      (url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)));
  } catch {
    return false;
  }
}

function contentSecurityPolicy(html) {
  // Vite оставляет в index.html маленький скрипт выбора темы: разрешаем его по хэшу.
  const hashes = [...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => `'sha256-${createHash("sha256").update(match[1]).digest("base64")}'`);
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${hashes.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' blob:",
    "connect-src 'self' blob:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join("; ");
}

class BackendProcess extends EventEmitter {
  constructor(launch, log = () => {}) {
    super();
    this.launch = launch;
    this.log = log;
    this.tail = "";
    this.stopping = false;
  }

  start(timeoutMs = 60_000) {
    return new Promise((resolve, reject) => {
      const { command, args, options } = this.launch;
      const child = this.child = spawn(command, args, options);
      const timer = setTimeout(() => reject(new Error("Сервер не запустился за 60 секунд.")), timeoutMs);
      const fail = (error) => { clearTimeout(timer); reject(error); };
      child.stdin.on("error", () => {});
      const record = (chunk) => {
        const value = chunk.toString("utf8");
        this.tail = (this.tail + value).slice(-8000);
        this.log(value);
      };
      child.stdout.on("data", record);
      child.stderr.on("data", record);
      const lines = createInterface({ input: child.stdout });
      lines.on("line", (line) => {
        if (!line.startsWith("SS_DESKTOP_READY ")) return;
        try {
          const { port } = JSON.parse(line.slice("SS_DESKTOP_READY ".length));
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Некорректный порт");
          clearTimeout(timer);
          resolve(`http://127.0.0.1:${port}`);
        } catch (error) { fail(error); }
      });
      child.once("error", fail);
      this.closed = new Promise((done) => child.once("close", (code, signal) => {
        clearTimeout(timer);
        lines.close();
        fail(new Error(`Сервер завершился (код ${code}, сигнал ${signal}).\n${this.tail}`));
        done();
        if (!this.stopping) this.emit("unexpected-exit", code);
      }));
    });
  }

  async stop() {
    this.stopping = true;
    if (!this.child || this.child.exitCode !== null || this.child.signalCode !== null) return;
    this.child.stdin.end();
    const timer = setTimeout(() => this.child.kill(), 12_000);
    try { await this.closed; } finally { clearTimeout(timer); }
  }
}

module.exports = { BackendProcess, allowedExternalUrl, contentSecurityPolicy, launchOptions, persistentPortableResources };
