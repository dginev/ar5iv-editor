import type {
  ConverterVersion,
  NormalizedConvertRequest,
  NormalizedConvertResponse,
  NormalizedDiagnostic,
  ProjectHandle,
} from "./conversionTypes";
import { fatalResponse } from "./conversionTypes";
import type { ConversionProvider, ConversionSession, SyncFile } from "./conversionProvider";

const HEADER_USER = "x-ar5iv-user";

// The hosted session's rendered entry. The "blank" slot seeds `main.tex` and
// the backend renders `find_main_tex` (which picks it), so — like the web
// editor, whose blank-slot active path *is* this seeded `main.tex` — we upload
// the active buffer here so the user's content is what gets converted, instead
// of leaving the seed in place and rendering "Hello, world!". This is the
// single-active-file model; multi-file workspace sync is a separate feature.
const REMOTE_ENTRY = "main.tex";

/** Normalize a workspace-relative path for the session file routes:
 *  forward slashes, no leading slash, no `..` segments (anything
 *  suspicious returns undefined and the caller skips/falls back). */
function sanitizeRemotePath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((seg) => seg === ".." || seg === "")) {
    return undefined;
  }
  return normalized;
}

/** FNV-1a over bytes — cheap change detection for sync skip. */
function fnv1a(bytes: Uint8Array): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

interface UserEnvelope {
  readonly user_id: string;
}

interface SessionEnvelope {
  readonly id: string;
  readonly slot: string;
  readonly entry: string;
}

interface VersionInfo {
  readonly latexml_oxide: { readonly sha: string; readonly date: string; readonly url: string };
}

interface WriteAck {
  readonly version: number;
}

interface WireConvertRequest {
  readonly id: number;
  readonly active_file: string;
  readonly version: number;
  readonly preamble?: string;
  readonly profile?: string;
  readonly format?: string;
  readonly preload?: readonly string[];
}

interface WireDiagnostic {
  readonly severity: "info" | "warning" | "error" | "fatal";
  readonly category: string;
  readonly message: string;
  readonly source?: string;
  readonly from_line?: number;
  readonly from_col?: number;
  readonly to_line?: number;
  readonly to_col?: number;
}

interface WireConvertResponse {
  readonly id: number;
  readonly result: string;
  readonly status: string;
  readonly status_code: number;
  readonly version: number;
  readonly log: string;
  readonly timings?: {
    readonly build_us: number;
    readonly convert_ms: number;
    readonly post_ms: number;
    readonly total_ms: number;
  };
  readonly diagnostics?: readonly WireDiagnostic[];
  readonly sources?: readonly string[];
}

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}

export interface WebSocketConstructor {
  readonly OPEN: number;
  new(url: string): WebSocketLike;
}

// Subset of the Fetch `credentials` mode, declared locally so the shared
// module stays free of a DOM-lib dependency (it's compiled for both the
// browser web-extension host and the Node desktop host).
export type FetchCredentials = "include" | "omit" | "same-origin";

export interface HostedProviderOptions {
  readonly backendUrl: string;
  readonly webSocket: WebSocketConstructor;
  // Cross-origin credentials mode for backend fetches. Only the hosted web
  // showcase needs "include": its webview extension-host worker runs on a
  // per-webview subdomain and must send the apex's Anubis clearance cookie so
  // the cross-origin /api calls clear the bot-wall. The desktop adapter leaves
  // this unset — its managed server is local (no Anubis, no cookies) and the
  // Node host has no CORS anyway, so credentials are inert there.
  readonly credentials?: FetchCredentials;
  getUserId(): Promise<string | undefined>;
  setUserId(value: string): Promise<void>;
}

export class HostedBackendProvider implements ConversionProvider {
  readonly mode = "backend" as const;
  private readonly baseUrl: URL;

  constructor(private readonly options: HostedProviderOptions) {
    this.baseUrl = new URL(options.backendUrl);
  }

  async openProject(_project: ProjectHandle): Promise<ConversionSession> {
    const userId = await this.ensureUserId();
    const [session, converter] = await Promise.all([
      this.callJson<SessionEnvelope>("/api/session", { method: "POST", body: JSON.stringify({ slot: "blank" }) }, userId),
      this.fetchConverterVersion(),
    ]);
    return new HostedConversionSession(
      this.baseUrl,
      this.options.webSocket,
      userId,
      session,
      converter,
      this.options.credentials,
    );
  }

  async dispose(): Promise<void> {}

  /** Best-effort backend build identity for the preview footer. Failure is
   *  non-fatal: conversion still works without the version label. */
  private async fetchConverterVersion(): Promise<ConverterVersion | undefined> {
    try {
      const response = await fetch(this.httpUrl("/api/version"), { credentials: this.options.credentials });
      if (!response.ok) return undefined;
      const body = (await response.json()) as VersionInfo;
      return {
        name: "latexml-oxide",
        sha: body.latexml_oxide?.sha,
        date: body.latexml_oxide?.date,
        url: body.latexml_oxide?.url,
      };
    } catch {
      return undefined;
    }
  }

  private async ensureUserId(): Promise<string> {
    const cached = await this.options.getUserId();
    if (cached) return cached;
    const response = await fetch(this.httpUrl("/api/user"), { method: "POST", credentials: this.options.credentials });
    if (!response.ok) {
      throw new Error(`POST /api/user failed: ${response.status} ${await response.text()}`);
    }
    const body = (await response.json()) as UserEnvelope;
    await this.options.setUserId(body.user_id);
    return body.user_id;
  }

  private async callJson<T>(path: string, init: RequestInit, userId: string): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set(HEADER_USER, userId);
    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }
    const response = await fetch(this.httpUrl(path), { ...init, headers, credentials: this.options.credentials });
    if (!response.ok) {
      throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  private httpUrl(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }
}

class HostedConversionSession implements ConversionSession {
  constructor(
    private readonly baseUrl: URL,
    private readonly webSocket: WebSocketConstructor,
    private readonly userId: string,
    private readonly session: SessionEnvelope,
    private readonly converter: ConverterVersion | undefined,
    private readonly credentials: FetchCredentials | undefined,
  ) {}

  async convert(request: NormalizedConvertRequest): Promise<NormalizedConvertResponse> {
    const sentAt = Date.now();
    // Convert under the document's REAL workspace-relative path (untitled
    // docs fall back to the fixed entry name). The fixed-name shortcut made
    // every multi-file project single-file server-side: siblings synced via
    // syncFiles could never be \input-resolved against an entry that had
    // been renamed to main.tex.
    const remotePath = sanitizeRemotePath(request.activeFile) ?? REMOTE_ENTRY;
    let version: number;
    try {
      const ack = await this.putText(remotePath, request.text);
      version = ack.version;
    } catch (error) {
      return fatalResponse(request, error instanceof Error ? error.message : String(error));
    }

    const wireRequest: WireConvertRequest = {
      id: request.id,
      active_file: remotePath,
      version,
      preamble: request.preamble,
      profile: request.profile ?? "fragment",
      format: request.format ?? "html5",
      preload: request.preload,
    };

    try {
      const wireResponse = await this.roundTrip(wireRequest);
      return normalizeResponse(request, wireResponse, Date.now() - sentAt, this.converter);
    } catch (error) {
      return fatalResponse(request, error instanceof Error ? error.message : String(error));
    }
  }

  async dispose(): Promise<void> {}

  /** Push workspace siblings, skipping bytes the server already has
   *  (FNV-1a content hash per path). Failures are per-file and non-fatal:
   *  a missing sibling degrades that \input, not the whole preview. */
  async syncFiles(files: readonly SyncFile[]): Promise<void> {
    for (const file of files) {
      const path = sanitizeRemotePath(file.path);
      if (!path) continue;
      const hash = fnv1a(file.bytes);
      if (this.syncedHashes.get(path) === hash) continue;
      try {
        await this.putBytes(path, file.bytes);
        this.syncedHashes.set(path, hash);
      } catch (error) {
        console.warn(`ar5iv: sync of ${path} failed:`, error);
      }
    }
  }

  private readonly syncedHashes = new Map<string, number>();

  private async putBytes(path: string, bytes: Uint8Array): Promise<WriteAck> {
    const response = await fetch(this.httpUrl(`/api/session/${this.session.id}/files/${encodePath(path)}`), {
      method: "PUT",
      headers: {
        [HEADER_USER]: this.userId,
        "content-type": "application/octet-stream",
      },
      body: bytes as unknown as BodyInit,
      credentials: this.credentials,
    });
    if (!response.ok) {
      throw new Error(`PUT ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as WriteAck;
  }

  private async putText(path: string, text: string): Promise<WriteAck> {
    const response = await fetch(this.httpUrl(`/api/session/${this.session.id}/files/${encodePath(path)}`), {
      method: "PUT",
      headers: {
        [HEADER_USER]: this.userId,
        "content-type": "application/octet-stream",
      },
      body: text,
      credentials: this.credentials,
    });
    if (!response.ok) {
      throw new Error(`PUT ${path} failed: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as WriteAck;
  }

  private async roundTrip(request: WireConvertRequest): Promise<WireConvertResponse> {
    return await new Promise<WireConvertResponse>((resolve, reject) => {
      const ws = new this.webSocket(this.websocketUrl());
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("conversion timed out"));
      }, 60_000);

      ws.onopen = () => {
        ws.send(JSON.stringify(request));
      };
      ws.onmessage = (event) => {
        clearTimeout(timeout);
        ws.close();
        try {
          const text = typeof event.data === "string" ? event.data : String(event.data);
          resolve(JSON.parse(text) as WireConvertResponse);
        } catch (error) {
          reject(error);
        }
      };
      ws.onerror = () => {
        clearTimeout(timeout);
        reject(new Error("WebSocket conversion failed"));
      };
      ws.onclose = () => {
        clearTimeout(timeout);
      };
    });
  }

  private httpUrl(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private websocketUrl(): string {
    const url = new URL("/convert", this.baseUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("session_id", this.session.id);
    url.searchParams.set("user_id", this.userId);
    return url.toString();
  }
}

function normalizeResponse(
  request: NormalizedConvertRequest,
  response: WireConvertResponse,
  networkMs: number,
  converter: ConverterVersion | undefined,
): NormalizedConvertResponse {
  return {
    id: response.id,
    revision: request.revision,
    status: normalizeStatus(response.status, response.status_code),
    statusCode: response.status_code,
    engineStatus: response.status,
    html: response.result,
    diagnostics: (response.diagnostics ?? []).map(normalizeDiagnostic),
    sources: response.sources ?? [],
    log: response.log,
    timings: response.timings
      ? {
          buildUs: response.timings.build_us,
          convertMs: response.timings.convert_ms,
          postMs: response.timings.post_ms,
          totalMs: response.timings.total_ms,
          networkMs,
        }
      : { networkMs },
    converter,
    capabilities: {
      sourceMap: true,
      cancel: false,
      multiFileOverlay: false,
    },
  };
}

function normalizeDiagnostic(diagnostic: WireDiagnostic): NormalizedDiagnostic {
  return {
    severity: diagnostic.severity,
    category: diagnostic.category,
    message: diagnostic.message,
    source: diagnostic.source,
    from: diagnostic.from_line
      ? { line: diagnostic.from_line, column: diagnostic.from_col }
      : undefined,
    to: diagnostic.to_line
      ? { line: diagnostic.to_line, column: diagnostic.to_col }
      : undefined,
  };
}

function normalizeStatus(status: string, statusCode: number): NormalizedConvertResponse["status"] {
  if (status === "superseded") return "superseded";
  if (statusCode === 3 || /fatal/i.test(status)) return "fatal";
  // The engine still renders output for status_code 1 (warnings) and 2
  // (recoverable errors) as well as 0 (clean); treat all as "ok" so the preview
  // shows. The engine's own label ("1 warning", "2 errors") is carried in
  // `engineStatus` and shown verbatim, like the web editor.
  if (statusCode === 0 || statusCode === 1 || statusCode === 2 || /^ok$/i.test(status)) return "ok";
  return "error";
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
