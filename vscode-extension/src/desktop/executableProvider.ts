import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import * as child_process from "child_process";
import type { ConversionProvider, ConversionSession } from "../shared/conversionProvider";
import { ConversionUnavailableError } from "../shared/conversionProvider";
import type {
  NormalizedConvertRequest,
  NormalizedConvertResponse,
  ProjectHandle,
} from "../shared/conversionTypes";
import { fatalResponse } from "../shared/conversionTypes";
import { cachedBinaryPath, downloadReleaseBinary, type ReleaseBinarySpec } from "./binaryDownload";

/// Pinned latexml-oxide release for download-on-activation. Bump per release;
/// the per-platform asset matrix is gated on RELEASE_CRITERIA.md §11 Stage 1.
const LATEXML_OXIDE_VERSION = "0.6.2";
const LATEXML_OXIDE_SPEC: ReleaseBinarySpec = {
  binaryName: "latexml_oxide",
  label: "latexml-oxide engine",
  version: LATEXML_OXIDE_VERSION,
  releaseBaseUrl: "https://github.com/dginev/latexml-oxide/releases/download",
  assetName: (v, triple) => `latexml-oxide-${v}-${triple}.tar.gz`,
  cacheSubdir: "engine",
  repoUrl: "https://github.com/dginev/latexml-oxide",
};

let engineOutput: vscode.OutputChannel | undefined;
function output(): vscode.OutputChannel {
  if (!engineOutput) engineOutput = vscode.window.createOutputChannel("ar5iv: engine");
  return engineOutput;
}

export async function createExecutableProvider(
  context: vscode.ExtensionContext,
): Promise<ConversionProvider> {
  const executable = await resolveExecutablePath(context);
  if (!executable) {
    throw new ConversionUnavailableError(
      "executable",
      "No latexml-oxide engine is configured, on PATH, or downloadable for this platform.",
    );
  }
  return new ExecutableFallbackProvider(executable);
}

class ExecutableFallbackProvider implements ConversionProvider {
  readonly mode = "executable" as const;

  constructor(private readonly executable: string) {}

  async openProject(_project: ProjectHandle): Promise<ConversionSession> {
    return new ExecutableFallbackSession(this.executable);
  }

  async dispose(): Promise<void> {}
}

interface PendingRequest {
  resolve: (res: any) => void;
  reject: (err: Error) => void;
}

class LspProcess {
  private readonly child: child_process.ChildProcess;
  private buffer = "";
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private nextId = 2;
  private isDead = false;
  private exitError: Error | undefined;

  constructor(executable: string) {
    this.child = child_process.spawn(executable, ["--server"]);
    this.child.stdout?.setEncoding("utf-8");
    this.child.stdout?.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.parseBuffer();
    });
    this.child.on("error", (err) => {
      console.error("LSP server process error:", err);
      this.handleExit(err);
    });
    this.child.on("exit", (code, signal) => {
      const msg = `LSP server process exited with code ${code} and signal ${signal}`;
      console.log(msg);
      this.handleExit(new Error(msg));
    });

    // Send LSP initialization handshake
    try {
      this.send({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      });
    } catch (err: any) {
      this.handleExit(err);
    }
  }

  private handleExit(err: Error) {
    if (this.isDead) return;
    this.isDead = true;
    this.exitError = err;

    // Reject all pending requests
    for (const req of this.pendingRequests.values()) {
      req.reject(err);
    }
    this.pendingRequests.clear();
  }

  private send(msg: any) {
    if (this.isDead) {
      throw this.exitError || new Error("LSP server process is dead");
    }
    const body = JSON.stringify(msg);
    const payload = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
    if (!this.child.stdin?.writable) {
      throw new Error("LSP server process stdin is not writable");
    }
    this.child.stdin.write(payload, "utf-8");
  }

  request(method: string, params: any): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.isDead) {
        return reject(this.exitError || new Error("LSP server process is dead"));
      }
      this.pendingRequests.set(id, { resolve, reject });
      try {
        this.send({
          jsonrpc: "2.0",
          id,
          method,
          params,
        });
      } catch (err) {
        this.pendingRequests.delete(id);
        reject(err);
      }
    });
  }

  private parseBuffer() {
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        break;
      }
      const headerPart = this.buffer.substring(0, headerEnd);
      let contentLength = 0;
      for (const line of headerPart.split("\r\n")) {
        if (line.toLowerCase().startsWith("content-length:")) {
          const parts = line.split(":");
          const lenStr = parts[1];
          if (lenStr !== undefined) {
            const parsedLen = parseInt(lenStr.trim(), 10);
            if (!isNaN(parsedLen)) {
              contentLength = parsedLen;
            }
          }
        }
      }
      const bodyStart = headerEnd + 4;
      if (this.buffer.length < bodyStart + contentLength) {
        break;
      }
      const bodyPart = this.buffer.substring(bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.substring(bodyStart + contentLength);

      try {
        const msg = JSON.parse(bodyPart);
        if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
          const req = this.pendingRequests.get(msg.id);
          this.pendingRequests.delete(msg.id);
          req?.resolve(msg);
        }
      } catch (err) {
        console.error("Failed to parse LSP response body:", err);
      }
    }
  }

  dispose() {
    if (!this.isDead) {
      this.child.kill();
    }
  }
}

class ExecutableFallbackSession implements ConversionSession {
  private lsp: LspProcess | undefined;

  constructor(private readonly executable: string) {}

  async convert(request: NormalizedConvertRequest): Promise<NormalizedConvertResponse> {
    if (!this.lsp) {
      this.lsp = new LspProcess(this.executable);
    }

    try {
      const resp = await this.lsp.request("latexml/convert", {
        uri: request.activeUri,
        text: request.text,
      });

      if (resp && resp.result) {
        const res = resp.result;
        return {
          id: request.id,
          revision: request.revision,
          status: res.status || "ok",
          statusCode: res.statusCode || 0,
          engineStatus: res.status || "ok",
          html: res.html || "",
          diagnostics: res.diagnostics || [],
          sources: res.sources || [],
          log: res.log || "",
        };
      } else if (resp && resp.error) {
        return fatalResponse(request, resp.error.message || "LSP conversion error");
      } else {
        return fatalResponse(request, "Invalid response from LSP fallback server");
      }
    } catch (err: any) {
      return fatalResponse(request, `LSP fallback conversion failed: ${err?.message || err}`);
    }
  }

  async dispose(): Promise<void> {
    if (this.lsp) {
      this.lsp.dispose();
      this.lsp = undefined;
    }
  }
}

/// Resolve the latexml-oxide LSP engine. Order (mirrors the ar5iv-editor
/// server resolution): explicit override → previously-downloaded cache → on
/// PATH (dev/system) → download the pinned release on first use. The download
/// is what makes a fresh install turnkey (RELEASE_CRITERIA.md §11 Stage 2).
async function resolveExecutablePath(
  context: vscode.ExtensionContext,
): Promise<string | undefined> {
  const config = vscode.workspace.getConfiguration("ar5iv");

  // 1. Explicit override.
  const configured = config.get<string>("latexmlOxidePath", "").trim();
  if (configured) {
    await assertExecutable(configured);
    return configured;
  }

  // 2. Previously downloaded, cached engine.
  const cached = cachedBinaryPath(context, LATEXML_OXIDE_SPEC);
  if (await isExecutable(cached)) return cached;

  // 3. On PATH (dev / system install).
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "latexml_oxide");
    if (await isExecutable(candidate)) return candidate;
  }

  // 4. Download the pinned release on first use.
  if (!config.get<boolean>("latexmlOxideDownload", true)) return undefined;
  const baseOverride = config.get<string>("latexmlOxideDownloadBaseUrl", "").trim();
  return downloadReleaseBinary(context, output(), LATEXML_OXIDE_SPEC, baseOverride || undefined);
}

async function assertExecutable(file: string): Promise<void> {
  if (!(await isExecutable(file))) {
    throw new ConversionUnavailableError("executable", `${file} is not executable or does not exist.`);
  }
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
