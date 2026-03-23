const http = require("http");
const { execFile, spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const TIMEOUT = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

// ── Helpers ────────────────────────────────────────────

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function json(res, status, data) {
  cors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

/** Run adb with simple args (devices, version). Rejects on non-zero exit. */
function adb(args) {
  return new Promise((resolve, reject) => {
    execFile("adb", args, { timeout: TIMEOUT, maxBuffer: MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr?.trim() || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * Run a shell command on device via stdin piping.
 * Avoids Windows argument quoting issues with complex shell commands.
 * Returns stdout even on non-zero exit codes (common for probe scripts).
 */
function adbShell(command, serial) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (serial) args.push("-s", serial);
    args.push("shell");

    const proc = spawn("adb", args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        proc.kill();
        reject(new Error("Command timed out"));
      }
    }, TIMEOUT);

    proc.stdout.on("data", (data) => { stdout += data; });
    proc.stderr.on("data", (data) => { stderr += data; });

    proc.on("close", () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      // Always resolve with stdout — device commands often exit non-zero
      // (e.g. probe scripts where some iterations fail) but still produce
      // valid output. Only reject if we got nothing and stderr has content.
      if (!stdout && stderr.trim()) {
        reject(new Error(stderr.trim()));
      } else {
        resolve(stdout);
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(err);
    });

    // Send command through stdin — bypasses Windows command-line quoting entirely
    proc.stdin.write(command + "\n");
    proc.stdin.end();
  });
}

// ── Routes ─────────────────────────────────────────────

async function handlePing(_req, res) {
  json(res, 200, { ok: true });
}

async function handleDevices(_req, res) {
  try {
    const raw = await adb(["devices", "-l"]);
    const lines = raw.split("\n").slice(1); // skip header
    const devices = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("*")) continue;
      const parts = trimmed.split(/\s+/);
      const serial = parts[0];
      const state = parts[1];
      if (state !== "device") continue;

      // Extract model from "model:<value>" token
      let model = "";
      for (const p of parts.slice(2)) {
        if (p.startsWith("model:")) {
          model = p.slice(6);
          break;
        }
      }
      devices.push({
        serial,
        display_name: model ? `${model} (${serial})` : serial,
      });
    }
    json(res, 200, { devices });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleShell(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { command, serial } = body;
  if (!command || typeof command !== "string") {
    json(res, 400, { error: "Missing 'command' string in body" });
    return;
  }

  try {
    const output = await adbShell(command, serial);
    json(res, 200, { output });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handlePushSqlite3(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    body = {};
  }
  const { serial } = body;

  // Locate bundled sqlite3-arm64 binary (check multiple locations)
  const candidates = [
    path.join(__dirname, "..", "sqlite3-arm64"),          // npm package / dev
    path.join(path.dirname(process.execPath), "sqlite3-arm64"), // next to pkg exe
  ];
  const binaryPath = candidates.find((p) => fs.existsSync(p));
  if (!binaryPath) {
    json(res, 404, { error: "Bundled sqlite3-arm64 binary not found. Place it next to adb-bridge.exe." });
    return;
  }

  try {
    // Push to /data/local/tmp/
    const pushArgs = [];
    if (serial) pushArgs.push("-s", serial);
    pushArgs.push("push", binaryPath, "/data/local/tmp/sqlite3");
    await adb(pushArgs);

    // Make executable
    const chmodArgs = [];
    if (serial) chmodArgs.push("-s", serial);
    chmodArgs.push("shell", "chmod", "755", "/data/local/tmp/sqlite3");
    await adb(chmodArgs);

    // Verify
    const verifyArgs = [];
    if (serial) verifyArgs.push("-s", serial);
    verifyArgs.push("shell", "/data/local/tmp/sqlite3", "-version");
    const version = await adb(verifyArgs);

    json(res, 200, { ok: true, version: version.trim() });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handlePullDb(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { serial, packageName, dbPath } = body;
  if (!packageName || !dbPath) {
    json(res, 400, { error: "Missing packageName or dbPath" });
    return;
  }

  const tmpFile = path.join(
    require("os").tmpdir(),
    `adb-pull-${Date.now()}.db`
  );

  try {
    // Copy from app sandbox to /data/local/tmp/ (run-as required)
    await adbShell(
      `run-as ${packageName} cat ${dbPath} > /data/local/tmp/_pull_db.tmp`,
      serial
    );

    // Pull to host
    const pullArgs = [];
    if (serial) pullArgs.push("-s", serial);
    pullArgs.push("pull", "/data/local/tmp/_pull_db.tmp", tmpFile);
    await adb(pullArgs);

    // Stream the file back
    const stat = fs.statSync(tmpFile);
    const fileName = dbPath.split("/").pop() || "database.db";
    cors(res);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": stat.size,
    });
    const stream = fs.createReadStream(tmpFile);
    stream.pipe(res);
    stream.on("end", () => {
      try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    });
  } catch (err) {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
    json(res, 500, { error: err.message });
  }
}

// ── WayDroid host filesystem access ─────────────────────

const os = require("os");
const WAYDROID_DATA_PATHS = [
  path.join(os.homedir(), ".local/share/waydroid/data/data"),
  "/var/lib/waydroid/data/data",
];

function findWaydroidDataPath() {
  for (const p of WAYDROID_DATA_PATHS) {
    try {
      fs.accessSync(p, fs.constants.F_OK);
      return p;
    } catch { /* not found */ }
  }
  return null;
}

/**
 * Read a file, trying direct access first, then pkexec cat.
 * Returns a Buffer.
 */
function readProtectedFile(filePath) {
  return new Promise((resolve, reject) => {
    // Try direct read first
    try {
      const data = fs.readFileSync(filePath);
      return resolve(data);
    } catch { /* permission denied, try pkexec */ }

    // Try pkexec (Linux GUI sudo prompt)
    execFile("pkexec", ["cat", filePath], {
      timeout: 30_000,
      maxBuffer: MAX_BUFFER,
      encoding: "buffer",
    }, (err, stdout) => {
      if (err) {
        reject(new Error(`Cannot read file (permission denied). Try: sudo chmod -R o+r ~/.local/share/waydroid/data/data/`));
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * List directory contents, trying direct access first, then pkexec ls.
 */
function listProtectedDir(dirPath) {
  return new Promise((resolve, reject) => {
    try {
      const entries = fs.readdirSync(dirPath);
      return resolve(entries);
    } catch { /* permission denied */ }

    execFile("pkexec", ["ls", dirPath], {
      timeout: 10_000,
    }, (err, stdout) => {
      if (err) {
        reject(new Error("Cannot list directory (permission denied)"));
      } else {
        resolve(stdout.split("\n").map(s => s.trim()).filter(Boolean));
      }
    });
  });
}

async function handleWaydroidDetect(_req, res) {
  const dataPath = findWaydroidDataPath();
  json(res, 200, { detected: !!dataPath, dataPath });
}

async function handleWaydroidPackages(_req, res) {
  const dataPath = findWaydroidDataPath();
  if (!dataPath) {
    json(res, 404, { error: "WayDroid data path not found" });
    return;
  }

  try {
    const entries = await listProtectedDir(dataPath);
    // Filter to likely app packages (com.xxx.xxx pattern)
    const packages = entries.filter(e => e.includes(".") && !e.startsWith("."));
    packages.sort();
    json(res, 200, { packages });
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

async function handleWaydroidDatabases(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { packageName } = body;
  if (!packageName) {
    json(res, 400, { error: "Missing packageName" });
    return;
  }

  const dataPath = findWaydroidDataPath();
  if (!dataPath) {
    json(res, 404, { error: "WayDroid data path not found" });
    return;
  }

  const locations = ["databases", "files", "files/SQLite"];
  const databases = [];
  const seen = new Set();

  for (const loc of locations) {
    const dirPath = path.join(dataPath, packageName, loc);
    try {
      const entries = await listProtectedDir(dirPath);
      for (const f of entries) {
        if (f.endsWith(".db") || f.endsWith(".sqlite") || f.endsWith(".sqlite3")) {
          if (!seen.has(f)) {
            seen.add(f);
            databases.push({ name: f, path: `${loc}/${f}` });
          }
        }
      }
    } catch { /* dir doesn't exist */ }
  }

  json(res, 200, { databases });
}

async function handleWaydroidReadDb(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "Invalid JSON body" });
    return;
  }

  const { packageName, dbPath } = body;
  if (!packageName || !dbPath) {
    json(res, 400, { error: "Missing packageName or dbPath" });
    return;
  }

  const dataPath = findWaydroidDataPath();
  if (!dataPath) {
    json(res, 404, { error: "WayDroid data path not found" });
    return;
  }

  const fullPath = path.join(dataPath, packageName, dbPath);

  // Prevent path traversal
  if (!fullPath.startsWith(dataPath)) {
    json(res, 400, { error: "Invalid path" });
    return;
  }

  try {
    const data = await readProtectedFile(fullPath);
    const fileName = dbPath.split("/").pop() || "database.db";
    cors(res);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Disposition": `attachment; filename="${fileName}"`,
      "Content-Length": data.length,
    });
    res.end(data);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}

// ── Exports (for use by cli/server.cjs and electron) ───

/**
 * Dispatch an incoming request to the appropriate API handler.
 * Returns true if a route was matched, false otherwise.
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;

  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    res.end();
    return true;
  }

  try {
    if (p === "/api/ping" && req.method === "GET") {
      await handlePing(req, res);
      return true;
    } else if (p === "/api/devices" && req.method === "GET") {
      await handleDevices(req, res);
      return true;
    } else if (p === "/api/shell" && req.method === "POST") {
      await handleShell(req, res);
      return true;
    } else if (p === "/api/push-sqlite3" && req.method === "POST") {
      await handlePushSqlite3(req, res);
      return true;
    } else if (p === "/api/pull-db" && req.method === "POST") {
      await handlePullDb(req, res);
      return true;
    } else if (p === "/api/waydroid/detect" && req.method === "GET") {
      await handleWaydroidDetect(req, res);
      return true;
    } else if (p === "/api/waydroid/packages" && req.method === "GET") {
      await handleWaydroidPackages(req, res);
      return true;
    } else if (p === "/api/waydroid/databases" && req.method === "POST") {
      await handleWaydroidDatabases(req, res);
      return true;
    } else if (p === "/api/waydroid/read-db" && req.method === "POST") {
      await handleWaydroidReadDb(req, res);
      return true;
    }
  } catch (err) {
    json(res, 500, { error: err.message });
    return true;
  }

  return false;
}

/**
 * Verify adb is in PATH. Returns the version string, or rejects.
 */
function checkAdb() {
  return new Promise((resolve, reject) => {
    execFile("adb", ["version"], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        reject(new Error("'adb' not found in PATH. Install Android SDK Platform-Tools."));
        return;
      }
      resolve(stdout.split("\n")[0].trim());
    });
  });
}

module.exports = { handleRequest, checkAdb };

// ── Standalone startup (node bridge/server.js) ─────────

if (require.main === module) {
  const PORT = 15555;
  const HOST = "127.0.0.1";

  const server = http.createServer(async (req, res) => {
    const handled = await handleRequest(req, res);
    if (!handled) {
      json(res, 404, { error: "Not found" });
    }
  });

  checkAdb()
    .then((versionLine) => {
      console.log(`Found: ${versionLine}`);
      server.listen(PORT, HOST, () => {
        console.log(`ADB Bridge listening on http://${HOST}:${PORT}`);
        console.log("Endpoints:");
        console.log("  GET  /api/ping     — health check");
        console.log("  GET  /api/devices  — list connected devices");
        console.log("  POST /api/shell    — run adb shell command");
        console.log("\nPress Ctrl+C to stop.");
        if (process.send) process.send({ type: "ready" });
      });
    })
    .catch((err) => {
      console.error("ERROR:", err.message);
      if (process.send) process.send({ type: "error", message: err.message });
      process.exit(1);
    });
}
