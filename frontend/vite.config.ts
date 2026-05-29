import { defineConfig } from "vite";
import { resolve } from "node:path";

// `examples/` lives at the workspace root, one level above this frontend
// project, so both the Rust server (via `include_dir!`) and the frontend
// (via `import.meta.glob`) can read the same source of truth. Vite's
// default fs.allow blocks reads outside the project root, so we extend it.
const repoRoot = resolve(__dirname, "..");

export default defineConfig({
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      // Two page entries, each emitted as `<name>.js` into the served dist:
      // `main.js` for the editor (/editor) and `upload.js` for the archive-drop
      // page (/upload). Both backend templates link `/static/<name>.js`.
      input: {
        main: "src/main.ts",
        upload: "src/upload.ts",
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: "[name][extname]",
      },
    },
    cssCodeSplit: false,
  },
  resolve: {
    alias: {
      "@examples": resolve(repoRoot, "examples"),
    },
  },
  server: {
    port: 5173,
    fs: {
      allow: [repoRoot],
    },
    proxy: {
      "/convert": { target: "ws://127.0.0.1:3000", ws: true },
      "/about":  "http://127.0.0.1:3000",
      "/help":   "http://127.0.0.1:3000",
      "/editor": "http://127.0.0.1:3000",
      "/upload": "http://127.0.0.1:3000",
      "/api":    "http://127.0.0.1:3000",
      // Without this, Vite's SPA fallback returns index.html for any
      // /static/* request — so `<script src="/static/main.js">` in the
      // backend-rendered editor template loads HTML, the browser parses
      // it as a JS module, fails silently, and the page stays inert.
      "/static": "http://127.0.0.1:3000",
    },
  },
});
