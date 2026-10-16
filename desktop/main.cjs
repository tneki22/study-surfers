const { app, BrowserWindow, dialog, Menu, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { BackendProcess, allowedExternalUrl, contentSecurityPolicy, launchOptions, persistentPortableResources } = require("./runtime.cjs");

// И portable, и установщик используют постоянный каталог вне ресурсов EXE.
const userRoot = path.resolve(process.env.SS_USER_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "StudySurfers"));
app.setPath("userData", userRoot);
const dataDir = path.resolve(process.env.SS_DATA_DIR || path.join(userRoot, "data"));
let backend;
let mainWindow;
let quitting = false;
let ready = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
  app.on("before-quit", (event) => {
    if (!backend || quitting) return;
    event.preventDefault();
    quitting = true;
    backend.stop().finally(() => app.quit());
  });
  app.on("window-all-closed", () => app.quit());
  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox("Не удалось запустить Study Surfers",
      `Проверьте доступность порта ${process.env.SS_PORT || 8765} и повторите запуск.\n\n` +
      `Журнал: ${path.join(dataDir, "logs", "desktop.log")}\n\n${error.message}`);
    app.quit();
  });
}

async function start() {
  const logsDir = path.join(dataDir, "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const logPath = path.join(logsDir, "desktop.log");
  if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2_000_000) {
    fs.renameSync(logPath, `${logPath}.previous`);
  }
  const log = (value) => fs.appendFileSync(logPath, value, "utf8");
  log(`\n${new Date().toISOString()} Study Surfers ${app.getVersion()}\n`);
  const projectRoot = path.resolve(__dirname, "..");
  // Portable распаковывается в случайную временную папку. Постоянный путь
  // бэкенда сохраняет настройки MCP между обычными перезапусками portable EXE.
  const backendResources = app.isPackaged && process.env.PORTABLE_EXECUTABLE_DIR
    ? persistentPortableResources(process.resourcesPath, userRoot) : process.resourcesPath;
  backend = new BackendProcess(launchOptions({
    packaged: app.isPackaged,
    resourcesPath: backendResources,
    projectRoot,
    dataDir,
  }), log);
  backend.on("unexpected-exit", () => {
    if (!ready || quitting) return;
    dialog.showErrorBox("Сервер Study Surfers остановился",
      `Перезапустите приложение. Журнал: ${logPath}\n\n${backend.tail}`);
    app.quit();
  });
  const origin = await backend.start();
  if (quitting) return;
  const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok || (await response.json()).status !== "ok") throw new Error("Сервер не прошёл проверку готовности.");
  const index = app.isPackaged
    ? path.join(process.resourcesPath, "backend", "_internal", "frontend", "dist", "index.html")
    : path.join(projectRoot, "frontend", "dist", "index.html");
  const csp = contentSecurityPolicy(fs.readFileSync(index, "utf8"));
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onHeadersReceived({ urls: [`${origin}/*`] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": [csp] } });
  });
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    title: "Study Surfers",
    backgroundColor: "#103560",
    icon: app.isPackaged ? path.join(process.resourcesPath, "icon.ico")
      : path.join(projectRoot, "frontend", "public", "branding", "icon-192.png"),
    show: false,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false },
  });
  const openExternal = (url) => {
    if (allowedExternalUrl(url)) shell.openExternal(url).catch((error) => log(`${error.message}\n`));
  };
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (new URL(url).origin !== origin) { event.preventDefault(); openExternal(url); }
  });
  mainWindow.webContents.on("will-attach-webview", (event) => event.preventDefault());
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    log(`Процесс интерфейса завершился: ${details.reason}\n`);
    dialog.showErrorBox("Интерфейс Study Surfers остановился", "Перезапустите приложение.");
    app.quit();
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Приложение", submenu: [
      { label: "Открыть папку данных", click: () => shell.openPath(dataDir) },
      { type: "separator" }, { label: "Выход", role: "quit" },
    ] },
    { label: "Правка", submenu: [
      { label: "Отменить", role: "undo" }, { label: "Повторить", role: "redo" },
      { type: "separator" }, { label: "Вырезать", role: "cut" },
      { label: "Копировать", role: "copy" }, { label: "Вставить", role: "paste" },
      { label: "Выбрать всё", role: "selectAll" },
    ] },
    { label: "Вид", submenu: [
      { label: "Обновить", role: "reload" }, { label: "Во весь экран", role: "togglefullscreen" },
      { label: "Увеличить", role: "zoomIn" }, { label: "Уменьшить", role: "zoomOut" },
      { label: "Масштаб 100%", role: "resetZoom" },
      ...(!app.isPackaged ? [{ label: "Инструменты разработчика", role: "toggleDevTools" }] : []),
    ] },
  ]));
  await mainWindow.loadURL(origin);
  ready = true;
  mainWindow.show();
}
