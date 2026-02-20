"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");
const { exec } = require("child_process");
const { handleRequest: bridgeHandler } = require("../bridge/server.js");
const { ensureAdb } = require("./ensure-adb.cjs");

const DIST_DIR = path.join(__dirname, "..", "dist");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(req, res) {
  let urlPath = new URL(req.url, "http://localhost").pathname;
  if (urlPath === "/") urlPath = "/index.html";

  const filePath = path.join(DIST_DIR, urlPath);
  const resolved = path.resolve(filePath);

  // Prevent path traversal
  if (!resolved.startsWith(path.resolve(DIST_DIR))) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (err, data) => {
    if (err) {
      // SPA fallback — serve index.html for unknown paths
      fs.readFile(path.join(DIST_DIR, "index.html"), (err2, html) => {
        if (err2) {
          res.writeHead(500);
          res.end("dist/index.html not found. Was the package built?");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(resolved);
    const mime = MIME[ext] || "application/octet-stream";
    const isHashed = /assets[\\/].*\.[a-f0-9A-Z_-]{5,}\.(js|css)$/.test(resolved);
    res.writeHead(200, {
      "Content-Type": mime,
      "Cache-Control": isHashed ? "public, max-age=31536000, immutable" : "no-cache",
    });
    res.end(data);
  });
}

async function requestHandler(req, res) {
  const urlPath = new URL(req.url, "http://localhost").pathname;

  if (urlPath.startsWith("/api/") || req.method === "OPTIONS") {
    const handled = await bridgeHandler(req, res);
    if (handled) return;
  }

  serveStatic(req, res);
}

function openBrowser(url) {
  const cmd =
    process.platform === "win32" ? `start "" "${url}"`
    : process.platform === "darwin" ? `open "${url}"`
    : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

async function start(port) {
  // Verify dist/ exists
  if (!fs.existsSync(path.join(DIST_DIR, "index.html"))) {
    console.error("ERROR: dist/index.html not found.");
    console.error("Run: npm run build:npm");
    process.exit(1);
  }

  // Ensure adb is available (downloads if needed)
  try {
    const version = await ensureAdb();
    console.log(`  adb: ${version}`);
  } catch (err) {
    console.warn(`  WARNING: ${err.message}`);
    console.warn("  ADB bridge features will not work.");
  }

  const server = http.createServer(requestHandler);

  server.listen(port, "127.0.0.1", () => {
    const url = `http://127.0.0.1:${port}`;
    console.log("");
    console.log("  ADB SQLite DevTools");
    console.log(`  Running at ${url}`);
    console.log("");
    console.log("  Press Ctrl+C to stop.");
    console.log("");
    setTimeout(() => openBrowser(url), 300);
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${port} is already in use. Try: sqlite-viewer --port ${port + 1}`);
    } else {
      console.error("Server error:", err.message);
    }
    process.exit(1);
  });
}

module.exports = { start };
