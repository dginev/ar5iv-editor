import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";
import * as vscode from "vscode";

type ManagedServerProcess = ChildProcessByStdio<null, Readable, Readable>;

const READY_TIMEOUT_MS = 30_000;
const READY_POLL_MS = 250;

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

    const executable = resolveServerExecutable(this.context);
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

function resolveServerExecutable(context: vscode.ExtensionContext): string {
  const configured = vscode.workspace.getConfiguration("ar5iv").get<string>("serverPath", "").trim();
  const extensionRoot = context.extensionPath;
  const repoRoot = path.resolve(extensionRoot, "..");
  const candidates = [
    configured || undefined,
    path.join(extensionRoot, "bin", executableName("ar5iv-editor")),
    path.join(repoRoot, "target", "release", executableName("ar5iv-editor")),
    path.join(repoRoot, "target", "debug", executableName("ar5iv-editor")),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    if (isExecutable(candidate)) return candidate;
  }

  throw new Error(
    [
      "No ar5iv-editor server binary found.",
      "Set ar5iv.serverPath or package a binary at vscode-extension/bin/ar5iv-editor.",
      `Tried: ${candidates.join(", ")}`,
    ].join(" "),
  );
}

function executableName(base: string): string {
  return os.platform() === "win32" ? `${base}.exe` : base;
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
