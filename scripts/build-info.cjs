const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const release = path.join(root, "release");
const version = require("../package.json").version;
const hash = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const git = (...args) => {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true }).trim(); }
  catch { return null; }
};
const target = process.argv[2];
const kinds = target === "dir" ? [] : target === "setup" ? ["Setup"] : target === "portable" ? ["Portable"] : ["Setup", "Portable"];
const artifacts = kinds.map((kind) => `Study-Surfers-${version}-${kind}-x64.exe`);
const sourceFiles = [];
function collect(directory, prefix) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === "__pycache__" || entry.name.endsWith(".pyc")) continue;
    const full = path.join(directory, entry.name);
    const relative = `${prefix}/${entry.name}`;
    if (entry.isDirectory()) collect(full, relative);
    else sourceFiles.push([relative, hash(full)]);
  }
}
collect(path.join(root, "build/workspace/frontend/src"), "frontend/src");
collect(path.join(root, "build/workspace/frontend/public"), "frontend/public");
collect(path.join(root, "backend/app"), "backend/app");
const sourcesSha256 = createHash("sha256").update(JSON.stringify(sourceFiles)).digest("hex");
const info = {
  version, target, builtAt: new Date().toISOString(),
  commit: git("rev-parse", "HEAD"), dirty: Boolean(git("status", "--porcelain")),
  node: process.version, electron: require("../build/desktop-tools/node_modules/electron/package.json").version,
  sourcesSha256,
  sha256: Object.fromEntries(artifacts.map((name) => [name, hash(path.join(release, name))])),
};
fs.writeFileSync(path.join(release, "build-info.json"), JSON.stringify(info, null, 2) + "\n");
fs.writeFileSync(path.join(release, "SHA256SUMS.txt"), artifacts.map((name) => `${info.sha256[name]}  ${name}\n`).join(""));
const python = path.join(root, "backend/.venv-build/Scripts/python.exe");
fs.writeFileSync(path.join(release, "python-packages.txt"), execFileSync(python, ["-m", "pip", "freeze"], { encoding: "utf8", windowsHide: true }));
console.log(`Версия ${version}; SHA256 и состав Python сохранены в release.`);
