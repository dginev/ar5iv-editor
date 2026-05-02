import { defineConfig } from "vite";

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: "src/main.ts",
      output: {
        entryFileNames: "main.js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
    cssCodeSplit: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/convert": { target: "ws://127.0.0.1:3000", ws: true },
      "/about":  "http://127.0.0.1:3000",
      "/help":   "http://127.0.0.1:3000",
      "/editor": "http://127.0.0.1:3000",
      // Without this, Vite's SPA fallback returns index.html for any
      // /static/* request — so `<script src="/static/main.js">` in the
      // backend-rendered editor template loads HTML, the browser parses
      // it as a JS module, fails silently, and the page stays inert.
      "/static": "http://127.0.0.1:3000",
    },
  },
});
