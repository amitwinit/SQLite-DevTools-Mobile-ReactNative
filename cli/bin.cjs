#!/usr/bin/env node
"use strict";

let port = 8085;
const args = process.argv.slice(2);

for (let i = 0; i < args.length; i++) {
  if ((args[i] === "--port" || args[i] === "-p") && args[i + 1]) {
    port = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i].startsWith("--port=")) {
    port = parseInt(args[i].split("=")[1], 10);
  } else if (args[i] === "--help" || args[i] === "-h") {
    console.log("Usage: sqlite-viewer [--port <number>]");
    console.log("  --port, -p   Port to listen on (default: 8085)");
    process.exit(0);
  }
}

if (isNaN(port) || port < 1 || port > 65535) {
  console.error("Invalid port number.");
  process.exit(1);
}

require("./server.cjs").start(port);
