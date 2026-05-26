const esbuild = require("esbuild");

esbuild.build({
  entryPoints: ["src/web/extension.ts"],
  bundle: true,
  external: ["vscode"],
  format: "cjs",
  platform: "browser",
  target: "es2022",
  sourcemap: true,
  outfile: "dist/web/extension.js",
}).catch(() => process.exit(1));
