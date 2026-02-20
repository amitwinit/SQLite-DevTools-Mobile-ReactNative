import { defineConfig } from "vite";

const isLocal = !!process.env.BUILD_TARGET; // "electron" or "npm"

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
});
