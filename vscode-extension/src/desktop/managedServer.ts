import * as crypto from "crypto";
import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { execFile, spawn, type ChildProcessByStdio } from "child_process";
import { promisify } from "util";
import type { Readable } from "stream";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

type ManagedServerProcess = ChildProcessByStdio<null, Readable, Readable>;

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;

// Pinned ar5iv-editor server release the plugin downloads when no local binary
// is available. Bump together with the published GitHub release tag.
const SERVER_VERSION = "0.2.0";
const RELEASE_BASE_URL = "https://github.com/dginev/ar5iv-editor/releases/download";

export class ManagedAr5ivServer {
  private child: ManagedServerProcess | undefined;
  private backendUrl: string | undefined;
  private stopping = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
  ) {}

  async start(): Promise<string> {
    if (this.backendUrl) return this.backendUrl;
    this.stopping = false;

    const executable = await resolveServerExecutable(this.context, this.output);
    const port = await reservePort();
    const url = `http://127.0.0.1:${port}`;
    const sessionsDir = path.join(this.context.globalStorageUri.fsPath, "sessions");
    await fs.promises.mkdir(sessionsDir, { recursive: true });

    this.output.appendLine(`Starting ar5iv server: ${executable}`);
    this.output.appendLine(`Backend URL: ${url}`);

    const child = spawn(executable, [], {
      cwd: path.dirname(executable),
      detached: os.platform() !== "win32",
      env: {
        ...process.env,
        AR5IV_EDITOR_BIND: `127.0.0.1:${port}`,
        AR5IV_EDITOR_SESSIONS_DIR: sessionsDir,
        RUST_LOG: process.env.RUST_LOG ?? "info,ar5iv_editor=debug",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.child = child;
    child.stdout.on("data", (chunk) => this.output.append(chunk.toString()));
    child.stderr.on("data", (chunk) => this.output.append(chunk.toString()));
    child.on("exit", (code, signal) => {
      const suffix = signal ? `signal ${signal}` : `code ${code}`;
      this.output.appendLine(`ar5iv server exited with ${suffix}`);
      if (!this.stopping) {
        this.backendUrl = undefined;
        this.child = undefined;
      }
    });

    try {
      await Promise.race([waitForReady(url), waitForSpawnError(child)]);
      this.backendUrl = url;
      return url;
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    this.backendUrl = undefined;
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) return;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          if (os.platform() !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          // Process already exited.
        }
        resolve();
      }, 2000);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      try {
        if (os.platform() !== "win32" && child.pid) {
          process.kill(-child.pid, "SIGTERM");
        } else {
          child.kill("SIGTERM");
        }
      } catch {
        clearTimeout(timer);
        resolve();
      }
    });
  }
}

/** Resolve the ar5iv-editor server binary, downloading it on first use so a
 *  fresh marketplace install is plug-and-play. Resolution order:
 *  1. `ar5iv.serverPath` (explicit override);
 *  2. a previously downloaded binary cached in extension global storage;
 *  3. local dev binaries (only present when running from the repo via
 *     extensionDevelopmentPath; never in an installed VSIX);
 *  4. download the pinned release for this platform into global storage. */
async function resolveServerExecutable(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<string> {
  const config = vscode.workspace.getConfiguration("ar5iv");

  const configured = config.get<string>("serverPath", "").trim();
  if (configured) {
    if (isExecutable(configured)) return configured;
    throw new Error(`ar5iv.serverPath is set to ${configured}, but it is not an executable file.`);
  }

  const cached = downloadedBinaryPath(context);
  if (isExecutable(cached)) return cached;

  const repoRoot = path.resolve(context.extensionPath, "..");
  for (const dev of [
    path.join(context.extensionPath, "bin", executableName("ar5iv-editor")),
    path.join(repoRoot, "target", "release", executableName("ar5iv-editor")),
    path.join(repoRoot, "target", "debug", executableName("ar5iv-editor")),
  ]) {
    if (isExecutable(dev)) return dev;
  }

  if (!config.get<boolean>("serverDownload", true)) {
    throw new Error(
      "No ar5iv-editor server binary found and automatic download is disabled (ar5iv.serverDownload). Set ar5iv.serverPath to a binary.",
    );
  }
  return downloadServer(context, output);
}

function executableName(base: string): string {
  return os.platform() === "win32" ? `${base}.exe` : base;
}

/** Cached download location, versioned so a server bump fetches afresh. */
function downloadedBinaryPath(context: vscode.ExtensionContext): string {
  return path.join(
    context.globalStorageUri.fsPath,
    "server",
    SERVER_VERSION,
    executableName("ar5iv-editor"),
  );
}

/** The Rust target triple for this platform, or null when no prebuilt release
 *  is published for it yet (the MVP ships linux x86_64 only). */
function targetTriple(): string | null {
  if (os.platform() === "linux" && os.arch() === "x64") return "x86_64-unknown-linux-gnu";
  return null;
}

/** Download + verify + extract the pinned server release into global storage,
 *  showing progress. Returns the cached executable path. */
async function downloadServer(
  context: vscode.ExtensionContext,
  output: vscode.OutputChannel,
): Promise<string> {
  const triple = targetTriple();
  if (!triple) {
    throw new Error(
      `No prebuilt ar5iv-editor server is available for ${os.platform()}-${os.arch()} yet. ` +
        "Set ar5iv.serverPath to a locally built binary, or build one from https://github.com/dginev/ar5iv-editor.",
    );
  }

  const asset = `ar5iv-editor-${SERVER_VERSION}-${triple}.tar.gz`;
  const base = vscode.workspace.getConfiguration("ar5iv").get<string>("serverDownloadBaseUrl", "").trim() || RELEASE_BASE_URL;
  const url = `${base.replace(/\/$/, "")}/${SERVER_VERSION}/${asset}`;
  const destDir = path.dirname(downloadedBinaryPath(context));
  const destBinary = downloadedBinaryPath(context);

  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "ar5iv: downloading conversion backend…", cancellable: false },
    async () => {
      output.appendLine(`Downloading ar5iv-editor ${SERVER_VERSION} from ${url}`);
      const archive = await fetchBytes(url);
      const expected = await fetchText(`${url}.sha256`).then(parseSha256).catch(() => undefined);
      const actual = crypto.createHash("sha256").update(archive).digest("hex");
      if (expected && expected !== actual) {
        throw new Error(`ar5iv-editor download checksum mismatch (expected ${expected}, got ${actual}).`);
      }

      const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "ar5iv-server-"));
      try {
        const tarball = path.join(tmpDir, asset);
        await fs.promises.writeFile(tarball, archive);
        await execFileAsync("tar", ["-xzf", tarball, "-C", tmpDir]);
        const extracted = await findExecutable(tmpDir, executableName("ar5iv-editor"));
        if (!extracted) throw new Error("ar5iv-editor binary not found in the downloaded archive.");
        await fs.promises.mkdir(destDir, { recursive: true });
        await fs.promises.copyFile(extracted, destBinary);
        await fs.promises.chmod(destBinary, 0o755);
      } finally {
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
      }
      output.appendLine(`ar5iv-editor ${SERVER_VERSION} installed at ${destBinary}`);
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

/** Parse a `<hex>  <filename>` checksum sidecar (ripgrep/sha256sum format). */
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

function isExecutable(candidate: string): boolean {
  try {
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function reservePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === "object") {
          resolve(address.port);
        } else {
          reject(new Error("failed to reserve local port"));
        }
      });
    });
  });
}

async function waitForReady(url: string): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/version`);
      if (response.ok) return;
      lastError = new Error(`GET /api/version returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(READY_POLL_MS);
  }
  throw new Error(`Timed out waiting for managed ar5iv server: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

async function waitForSpawnError(child: ManagedServerProcess): Promise<never> {
  return await new Promise<never>((_, reject) => {
    child.once("error", (error) => reject(error));
    child.once("exit", (code, signal) => {
      const detail = signal ? "signal " + signal : "code " + code;
      reject(new Error("managed ar5iv server exited before readiness: " + detail));
    });
  });
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
