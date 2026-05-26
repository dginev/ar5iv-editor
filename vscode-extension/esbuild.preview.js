// Bundle the webview preview script (runs inside the preview iframe). Unlike
// the extension entry points this targets the browser and is loaded via a
// <script src> tag, so it is an IIFE with idiomorph + the shared preview core
// bundled in (no externals).
const esbuild = require("esbuild");

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["src/webview/preview.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  outfile: "media/preview.js",
};

if (watch) {
  esbuild.context(options).then((ctx) => ctx.watch());
} else {
  esbuild.build(options).catch(() => process.exit(1));
}
