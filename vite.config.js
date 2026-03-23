import { defineConfig } from "vite";
import { readFileSync } from "fs";

const isLocal = !!process.env.BUILD_TARGET; // "electron" or "npm"
const pkg = JSON.parse(readFileSync("./package.json", "utf-8"));

export default defineConfig({
  root: "src",
  base: isLocal ? "./" : "/SQLite-DevTools-Mobile-ReactNative/",
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    open: true,
  },
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  optimizeDeps: {
    exclude: ["sql.js"],
  },
});
