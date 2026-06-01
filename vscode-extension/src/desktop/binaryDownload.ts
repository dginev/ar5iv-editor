// Shared release-binary resolver/downloader for desktop providers.
//
// Generalizes the download-on-activation pattern (originally in
// `managedServer.ts` for the `ar5iv-editor` server) so any provider can fetch
// a pinned, per-platform GitHub release binary into extension global storage,
// checksum-verified and cached. Used by `executableProvider.ts` to obtain the
// `latexml_oxide` LSP server (RELEASE_CRITERIA.md §11, Stage 2 fallback).
//
// Desktop-only: uses node fs / child_process / fetch. The web variant has no
// subprocess and never calls this.

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

export interface ReleaseBinarySpec {
  /** Executable basename inside the archive, e.g. "latexml_oxide". */
  binaryName: string;
  /** Human label for progress/errors, e.g. "latexml-oxide engine". */
  label: string;
  /** Pinned release version / git tag, e.g. "0.6.2". */
  version: string;
  /** GitHub releases download base, e.g. ".../releases/download". */
  releaseBaseUrl: string;
  /** Archive filename for (version, target-triple). */
  assetName: (version: string, triple: string) => string;
  /** Cache subdirectory under global storage, e.g. "engine". */
  cacheSubdir: string;
  /** Human repo URL for error messages. */
  repoUrl: string;
}

export function executableName(base: string): string {
  return os.platform() === "win32" ? `${base}.exe` : base;
}

/** The Rust target triple for this platform, or `null` when no prebuilt
 *  release is published for it yet. Linux x86_64 only until the
 *  self-contained cross-platform matrix lands (RELEASE_CRITERIA.md §11
 *  Stage 1): then add macOS/Windows/arm64. */
export function targetTriple(): string | null {
  if (os.platform() === "linux" && os.arch() === "x64") return "x86_64-unknown-linux-gnu";
  return null;
}

export function isExecutable(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Cached download location, versioned so a version bump fetches afresh. */
export function cachedBinaryPath(context: vscode.ExtensionContext, spec: ReleaseBinarySpec): string {
  return path.join(
    context.globalStorageUri.fsPath,
    spec.cacheSubdir,
    spec.version,
    executableName(spec.binaryName),
  );
}

/** Download + checksum-verify + extract the pinned release into global
 *  storage, showing progress. Returns the cached executable path. */
export async function downloadReleaseBinary(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
  spec: ReleaseBinarySpec,
  baseUrlOverride?: string,
): Promise<string> {
  const triple = targetTriple();
  if (!triple) {
    throw new Error(
      `No prebuilt ${spec.binaryName} is available for ${os.platform()}-${os.arch()} yet. ` +
        `Set an explicit path, or build one from ${spec.repoUrl}.`,
    );
  }

  const asset = spec.assetName(spec.version, triple);
  const base = (baseUrlOverride && baseUrlOverride.trim()) || spec.releaseBaseUrl;
  const url = `${base.replace(/\/$/, "")}/${spec.version}/${asset}`;
  const destBinary = cachedBinaryPath(context, spec);
  const destDir = path.dirname(destBinary);

  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `ar5iv: downloading ${spec.label}…`,
      cancellable: false,
    },
    async () => {
      output.appendLine(`Downloading ${spec.binaryName} ${spec.version} from ${url}`);
      const archive = await fetchBytes(url);
      const expected = await fetchText(`${url}.sha256`).then(parseSha256).catch(() => undefined);
      const actual = crypto.createHash("sha256").update(archive).digest("hex");
      if (expected && expected !== actual) {
        throw new Error(`${spec.binaryName} download checksum mismatch (expected ${expected}, got ${actual}).`);
      }

      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), `${spec.cacheSubdir}-`));
      try {
        const tarball = path.join(tmpDir, asset);
        await fs.promises.writeFile(tarball, archive);
        await execFileAsync("tar", ["-xzf", tarball, "-C", tmpDir]);
        const extracted = await findExecutable(tmpDir, executableName(spec.binaryName));
        if (!extracted) throw new Error(`${spec.binaryName} not found in the downloaded archive.`);
        await fs.promises.mkdir(destDir, { recursive: true });
        await fs.promises.copyFile(extracted, destBinary);
        await fs.promises.chmod(destBinary, 0o755);
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      }
      output.appendLine(`${spec.binaryName} ${spec.version} installed at ${destBinary}`);
      return destBinary;
    },
  );
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: ${response.status} ${response.statusText} (${url})`);
  return Buffer.from(await response.arrayBuffer());
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`download failed: ${response.status} ${url}`);
  return response.text();
}

/** Parse a `<hex>  <filename>` checksum sidecar (sha256sum / ripgrep format). */
function parseSha256(text: string): string | undefined {
  return /\b([a-f0-9]{64})\b/i.exec(text)?.[1]?.toLowerCase();
}

/** Find an executable named `name` anywhere under `dir` (the archive may stage
 *  the binary inside a versioned subdirectory). */
async function findExecutable(dir: string, name: string): Promise<string | undefined> {
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findExecutable(full, name);
      if (nested) return nested;
    } else if (entry.name === name) {
      return full;
    }
  }
  return undefined;
}
