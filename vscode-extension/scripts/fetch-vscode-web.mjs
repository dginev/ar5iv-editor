#!/usr/bin/env node
// Fetch the official VS Code Web "web-standalone" build and vendor it into
// `vscode-web/` at the repo root, where the ar5iv server serves it at /vscode.
//
// The build is pinned to a specific commit + sha256 for reproducibility; set
// VSCODE_WEB_LATEST=1 to instead resolve the current `stable` release from the
// update API (and re-pin the constants below from its output). The vendored
// tree is gitignored (tens of MB) — every environment runs this once.
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";

// Pinned VS Code Web standalone (re-pin via VSCODE_WEB_LATEST=1, then copy the
// update-API `version`/`sha256hash` here).
const QUALITY = process.env.VSCODE_WEB_QUALITY || "stable";
const PINNED = {
  commit: "f6cfa2ea2403534de03f069bdf160d06451ed282",
  version: "1.121.0",
  sha256: "398d4b2bfc76f4255adbf8fe15804fd849ccb41c75fbd35ffd3bfe5e82490a65",
};

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const destDir = process.env.AR5IV_VSCODE_WEB_DIR
  ? path.resolve(process.env.AR5IV_VSCODE_WEB_DIR)
  : path.join(repoRoot, "vscode-web");
const stampPath = path.join(destDir, ".ar5iv-vscode-web-version");

async function resolveBuild() {
  if (process.env.VSCODE_WEB_LATEST) {
    const res = await fetch(`https://update.code.visualstudio.com/api/update/web-standalone/${QUALITY}/latest`);
    if (!res.ok) throw new Error(`update API failed: ${res.status}`);
    const meta = await res.json();
    return { commit: meta.version, version: meta.productVersion ?? meta.name, sha256: meta.sha256hash, url: meta.url };
  }
  return {
    ...PINNED,
    url: `https://vscode.download.prss.microsoft.com/dbazure/download/${QUALITY}/${PINNED.commit}/vscode-web.tar.gz`,
  };
}

async function alreadyPresent(commit) {
  try {
    return (await fs.readFile(stampPath, "utf8")).trim() === commit;
  } catch {
    return false;
  }
}

// The standalone build ships only the workbench *template* + ESM modules; the
// ESM bootstrap (`main.js`, which wires the WorkspaceProvider and calls
// `create()`) and the HTML template live in `@vscode/test-web`. Vendor both
// into `<build>/ar5iv/` so the Rust server can assemble the workbench page
// without a Node dependency at runtime. The server fixes the version-specific
// `workbench.web.main[.internal].{js,css}` names and the base URL itself.
async function vendorBootstrap() {
  const testWeb = path.join(here, "..", "node_modules", "@vscode", "test-web");
  const tmplSrc = path.join(testWeb, "views", "workbench-esm.html");
  const mainSrc = path.join(testWeb, "out", "browser", "esm", "main.js");
  try {
    await fs.access(tmplSrc);
    await fs.access(mainSrc);
  } catch {
    throw new Error(`@vscode/test-web bootstrap not found at ${testWeb}. Run \`npm install\` in vscode-extension/ first.`);
  }
  const outDir = path.join(destDir, "ar5iv");
  await fs.mkdir(outDir, { recursive: true });
  await fs.copyFile(tmplSrc, path.join(outDir, "workbench.html"));
  await fs.copyFile(mainSrc, path.join(outDir, "workbench-main.js"));
  console.log(`Vendored workbench bootstrap into ${outDir}`);
}

async function main() {
  const { commit, version, sha256, url } = await resolveBuild();
  if (await alreadyPresent(commit)) {
    console.log(`VS Code Web ${version} (${commit}) already vendored at ${destDir}`);
    await vendorBootstrap();
    return;
  }

  console.log(`Fetching VS Code Web ${version} (${commit})…`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${res.statusText}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256) {
    const got = createHash("sha256").update(buf).digest("hex");
    if (got !== sha256) throw new Error(`sha256 mismatch: expected ${sha256}, got ${got}`);
  }

  const tmpTar = path.join(os.tmpdir(), `vscode-web-${commit}.tar.gz`);
  const tmpExtract = path.join(os.tmpdir(), `vscode-web-extract-${commit}`);
  await fs.writeFile(tmpTar, buf);
  await fs.rm(tmpExtract, { recursive: true, force: true });
  await fs.mkdir(tmpExtract, { recursive: true });
  execFileSync("tar", ["-xzf", tmpTar, "-C", tmpExtract], { stdio: "inherit" });

  const extracted = path.join(tmpExtract, "vscode-web");
  await fs.rm(destDir, { recursive: true, force: true });
  await fs.mkdir(path.dirname(destDir), { recursive: true });
  try {
    await fs.rename(extracted, destDir);
  } catch {
    execFileSync("cp", ["-r", extracted, destDir], { stdio: "inherit" });
  }
  await fs.writeFile(stampPath, `${commit}\n`);
  await fs.rm(tmpTar, { force: true });
  await fs.rm(tmpExtract, { recursive: true, force: true });
  await vendorBootstrap();
  console.log(`VS Code Web ${version} ready at ${destDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
