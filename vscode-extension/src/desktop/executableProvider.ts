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

export async function createExecutableProvider(
  context: vscode.ExtensionContext,
): Promise<ConversionProvider> {
  const executable = await resolveExecutablePath(context);
  if (!executable) {
    throw new ConversionUnavailableError(
      "executable",
      "No latexml-oxide engine is configured, bundled with the extension, or on PATH.",
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
  // BYTE buffer, deliberately not a string: `Content-Length` counts UTF-8
  // BYTES, while a decoded JS string is measured in UTF-16 code units. The
  // old string-based parser compared bytes against chars, so any response
  // containing a multi-byte character (typographic quotes, π, MathML
  // operators — i.e. virtually every real document) came up "incomplete"
  // by the byte/char difference and the request promise never resolved:
  // a permanently blank preview. Frame in bytes; decode AFTER slicing.
  private buffer: Buffer = Buffer.alloc(0);
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private nextId = 2;
  private isDead = false;
  private exitError: Error | undefined;

  constructor(executable: string) {
    this.child = child_process.spawn(executable, ["--server"]);
    this.child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
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
      // Headers are ASCII; decoding just the header slice is safe.
      const headerPart = this.buffer.subarray(0, headerEnd).toString("utf-8");
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
      // Byte-to-byte comparison: contentLength is a byte count.
      if (this.buffer.length < bodyStart + contentLength) {
        break;
      }
      const bodyPart = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf-8");
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

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

/// Resolve the latexml-oxide LSP engine. Order: explicit override
/// (`ar5iv.latexmlOxidePath` — the dev escape hatch) → the engine BUNDLED
/// with the extension (`<extension>/bin/latexml_oxide`, packaged into the
/// vsix: single artifact, extension↔engine version-locked, the
/// rust-analyzer model) → on PATH (dev/system install). No download step:
/// the version-pin drift it allowed (extension testing a stale engine)
/// outweighed the smaller vsix. Linux-only by design — latexml-oxide
/// builds and is tested on Ubuntu only; other platforms fall back to the
/// hosted backend in runtime.ts.
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

  // 2. Bundled engine (shipped inside the vsix).
  const bundled = path.join(context.extensionPath, "bin", "latexml_oxide");
  if (await isExecutable(bundled)) return bundled;

  // 3. On PATH (dev / system install).
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "latexml_oxide");
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
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
