const { app, BrowserWindow, dialog, Menu } = require("electron");
const { autoUpdater } = require("electron-updater");
const { fork } = require("child_process");
const path = require("path");

let bridge = null;
let mainWindow = null;

// ── Auto-Updater Setup ─────────────────────────────

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    console.log("Checking for updates...");
  });

  autoUpdater.on("update-available", (info) => {
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "Update Available",
        message: `Version ${info.version} is available (you have ${app.getVersion()}).`,
        detail: "Would you like to download it now?",
        buttons: ["Download", "Later"],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.downloadUpdate();
        }
      });
  });

  autoUpdater.on("update-not-available", () => {
    console.log("No updates available.");
  });

  autoUpdater.on("download-progress", (progress) => {
    if (mainWindow) {
      mainWindow.setProgressBar(progress.percent / 100);
    }
  });

  autoUpdater.on("update-downloaded", () => {
    if (mainWindow) mainWindow.setProgressBar(-1);
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        title: "Update Ready",
        message: "Update has been downloaded. Restart now to install?",
        buttons: ["Restart Now", "Later"],
        defaultId: 0,
      })
      .then((result) => {
        if (result.response === 0) {
          autoUpdater.quitAndInstall();
        }
      });
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err.message);
  });

  // Check for updates after a short delay
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("Update check failed:", err.message);
    });
  }, 3000);
}

// ── Application Menu ────────────────────────────────

function buildMenu() {
  const template = [
    {
      label: "File",
      submenu: [
        { role: "quit" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Help",
      submenu: [
        {
          label: "Check for Updates...",
          click: () => {
            autoUpdater
              .checkForUpdates()
              .then((result) => {
                if (!result || !result.updateInfo) {
                  dialog.showMessageBox(mainWindow, {
                    type: "info",
                    title: "No Updates",
                    message: `You are running the latest version (${app.getVersion()}).`,
                  });
                }
              })
              .catch(() => {
                dialog.showMessageBox(mainWindow, {
                  type: "info",
                  title: "No Updates",
                  message: `You are running the latest version (${app.getVersion()}).`,
                });
              });
          },
        },
        { type: "separator" },
        {
          label: "About",
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: "info",
              title: "About ADB SQLite DevTools",
              message: `ADB SQLite DevTools v${app.getVersion()}`,
              detail: "View and query SQLite databases on Android devices.",
            });
          },
        },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Bundled ADB ─────────────────────────────────────

function setupBundledAdb() {
  if (app.isPackaged) {
    const toolsDir = path.join(process.resourcesPath, "tools");
    const sep = process.platform === "win32" ? ";" : ":";
    process.env.PATH = toolsDir + sep + (process.env.PATH || "");
  }
}

// ── Bridge Server ───────────────────────────────────

function getBridgePath() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "bridge", "server.js");
  }
  return path.join(__dirname, "..", "bridge", "server.js");
}

function startBridge() {
  return new Promise((resolve, reject) => {
    const serverPath = getBridgePath();
    bridge = fork(serverPath, [], { silent: true });

    const timeout = setTimeout(() => {
      reject(new Error("Bridge server failed to start within 10 seconds"));
    }, 10_000);

    bridge.on("message", (msg) => {
      if (msg.type === "ready") {
        clearTimeout(timeout);
        resolve();
      } else if (msg.type === "error") {
        clearTimeout(timeout);
        reject(new Error(msg.message || "Bridge error"));
      }
    });

    bridge.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    bridge.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        clearTimeout(timeout);
        reject(new Error(`Bridge exited with code ${code}`));
      }
    });

    // Forward bridge logs to main process console
    bridge.stdout.on("data", (data) => {
      process.stdout.write(`[bridge] ${data}`);
    });
    bridge.stderr.on("data", (data) => {
      process.stderr.write(`[bridge] ${data}`);
    });
  });
}

// ── Window ──────────────────────────────────────────

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // __dirname works in both dev and packaged (asar transparency)
  const indexPath = path.join(__dirname, "..", "dist", "index.html");

  mainWindow.loadFile(indexPath);

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ── App Lifecycle ───────────────────────────────────

app.whenReady().then(async () => {
  setupBundledAdb();
  buildMenu();

  try {
    console.log("Starting ADB bridge server...");
    await startBridge();
    console.log("Bridge server ready.");
  } catch (err) {
    console.error("Failed to start bridge:", err.message);
    // Continue anyway — user can still use the app if they have standalone bridge
  }

  createWindow();

  setupAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", () => {
  if (bridge) {
    bridge.kill();
    bridge = null;
  }
});
