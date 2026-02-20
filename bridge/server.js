const http = require("http");
const { execFile, spawn } = require("child_process");

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
