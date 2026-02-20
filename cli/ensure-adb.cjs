"use strict";

const { execFile } = require("child_process");
const https = require("https");
const fs = require("fs");
const path = require("path");
const os = require("os");

const CACHE_DIR = path.join(os.homedir(), ".adb-sqlite-viewer");
const PLATFORM_TOOLS_DIR = path.join(CACHE_DIR, "platform-tools");

const DOWNLOAD_URLS = {
  win32: "https://dl.google.com/android/repository/platform-tools-latest-windows.zip",
  darwin: "https://dl.google.com/android/repository/platform-tools-latest-darwin.zip",
  linux: "https://dl.google.com/android/repository/platform-tools-latest-linux.zip",
};

const ADB_BIN = process.platform === "win32" ? "adb.exe" : "adb";

/** Check if adb works at the given path. Returns version string or null. */
function tryAdb(adbPath) {
  return new Promise((resolve) => {
    execFile(adbPath, ["version"], { timeout: 5000 }, (err, stdout) => {
      if (err) return resolve(null);
      resolve(stdout.split("\n")[0].trim());
    });
  });
}

/** Download a file via HTTPS, following redirects. */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (u) => {
      https.get(u, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          request(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }
        const total = parseInt(res.headers["content-length"], 10) || 0;
        let downloaded = 0;
        res.on("data", (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = Math.round((downloaded / total) * 100);
            process.stdout.write(`\r  Downloading... ${pct}%`);
          }
        });
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          if (total > 0) process.stdout.write("\n");
          resolve();
        });
      }).on("error", (err) => {
        file.close();
        fs.unlinkSync(dest);
        reject(err);
      });
    };
    request(url);
  });
}

/** Extract a zip file using OS tools. */
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === "win32"
      ? `tar -xf "${zipPath}" -C "${destDir}"`
      : `unzip -q -o "${zipPath}" -d "${destDir}"`;
    execFile(cmd.split(" ")[0], cmd.split(" ").slice(1), { shell: true, timeout: 60000 }, (err) => {
      if (err) reject(new Error(`Extract failed: ${err.message}`));
      else resolve();
    });
  });
}

/**
 * Ensure adb is available. Checks PATH, then cached download, then downloads.
 * Prepends the adb directory to process.env.PATH if needed.
 * Returns the adb version string.
 */
async function ensureAdb() {
  // 1. Check system PATH
  const systemVersion = await tryAdb("adb");
  if (systemVersion) {
    return systemVersion;
  }

  // 2. Check cached download
  const cachedAdb = path.join(PLATFORM_TOOLS_DIR, ADB_BIN);
  if (fs.existsSync(cachedAdb)) {
    const cachedVersion = await tryAdb(cachedAdb);
    if (cachedVersion) {
      prependToPath(PLATFORM_TOOLS_DIR);
      return cachedVersion;
    }
  }

  // 3. Download from Google
  const url = DOWNLOAD_URLS[process.platform];
  if (!url) {
    throw new Error(`Unsupported platform: ${process.platform}. Install adb manually.`);
  }

  console.log("  adb not found. Downloading Android Platform-Tools...");

  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const zipPath = path.join(CACHE_DIR, "platform-tools.zip");

  await download(url, zipPath);
  console.log("  Extracting...");
  await extractZip(zipPath, CACHE_DIR);

  // Clean up zip
  try { fs.unlinkSync(zipPath); } catch {}

  // Verify
  if (!fs.existsSync(cachedAdb)) {
    throw new Error("Download succeeded but adb binary not found in extracted files.");
  }

  // Make executable on Unix
  if (process.platform !== "win32") {
    fs.chmodSync(cachedAdb, 0o755);
  }

  const version = await tryAdb(cachedAdb);
  if (!version) {
    throw new Error("Downloaded adb binary is not working.");
  }

  prependToPath(PLATFORM_TOOLS_DIR);
  console.log(`  Downloaded: ${version}`);
  return version;
}

function prependToPath(dir) {
  const sep = process.platform === "win32" ? ";" : ":";
  process.env.PATH = dir + sep + (process.env.PATH || "");
}

module.exports = { ensureAdb };
