// Standalone archive-conversion page (`/upload`): ZIP-to-ZIP, no preview.
//
// Pick or drag-and-drop a self-sufficient LaTeX archive (.zip / .tar.gz /
// .tgz / .gz). It's imported into a fresh session via
// `POST /api/import-archive`, converted once over the same `/convert`
// WebSocket the editor uses (headless — nothing is rendered on this
// page), then the self-contained result bundle from
// `GET /api/session/{id}/export-zip` is streamed straight to a browser
// download. No conversion or preview logic lives here; this is the glue
// that turns the existing import + convert + export pipeline into a
// one-shot archive-in / archive-out form.

import "./styles.css";
import { ConvertClient, type ConvertResponse } from "./ws.ts";

// Matches the server's default archive cap (`quota_archive_bytes`,
// config.rs). Client-side reject before the upload so the user gets an
// immediate, friendly message instead of a 413 after a long transfer.
const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

const HEADER_USER = "x-ar5iv-user";
const LS_USER = "ar5iv.user_id";

function statusEl(): HTMLElement {
  return document.getElementById("status")!;
}
function logEl(): HTMLElement {
  return document.getElementById("log")!;
}
function setStatus(text: string): void {
  statusEl().textContent = text;
}
function showLog(text: string): void {
  const el = logEl();
  el.textContent = text;
  el.hidden = text.trim().length === 0;
}
function hideLog(): void {
  logEl().hidden = true;
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Accepted input archive extensions — mirrors what the server's
 *  `archive::sniff_format` + `collect_gzip` ingest: ZIP, gzipped tar, and
 *  a single gzipped file. (The server sniffs magic bytes regardless; this
 *  is the friendly client-side gate.) */
function isAcceptedArchive(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n.endsWith(".zip") ||
    n.endsWith(".tar.gz") ||
    n.endsWith(".tgz") ||
    n.endsWith(".gz")
  );
}

/** Advisory Content-Type — the server believes the magic bytes, not this,
 *  but send something honest. */
function archiveContentType(name: string): string {
  return name.toLowerCase().endsWith(".zip") ? "application/zip" : "application/gzip";
}

interface SessionEnvelope {
  id: string;
  slot: string;
  entry: string;
  files: Array<{ path: string; size: number; kind: string }>;
}

/** Mint (or reuse) the persistent anonymous user-id capability token,
 *  exactly like `session.ts::ensureUserId`. Credentialed because hosted
 *  calls require it per the project's CORS setup. */
async function ensureUserId(): Promise<string> {
  const cached = localStorage.getItem(LS_USER);
  if (cached) return cached;
  const resp = await fetch("/api/user", { method: "POST", credentials: "include" });
  if (!resp.ok) throw new Error(`POST /api/user failed: ${resp.status}`);
  const body = (await resp.json()) as { user_id: string };
  localStorage.setItem(LS_USER, body.user_id);
  return body.user_id;
}

/** POST the raw archive bytes to `/api/import-archive`, which unpacks them
 *  into a fresh per-archive session and returns the session envelope. */
async function importArchive(file: File, userId: string): Promise<SessionEnvelope> {
  const resp = await fetch("/api/import-archive", {
    method: "POST",
    credentials: "include",
    headers: {
      [HEADER_USER]: userId,
      "content-type": archiveContentType(file.name),
    },
    body: file,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `import failed (${resp.status})`);
  }
  return (await resp.json()) as SessionEnvelope;
}

function websocketUrl(sessionId: string, userId: string): string {
  const proto = location.protocol === "https:" ? "wss://" : "ws://";
  return (
    `${proto}${location.host}/convert?session_id=${encodeURIComponent(sessionId)}` +
    `&user_id=${encodeURIComponent(userId)}`
  );
}

/** Run one conversion over the WS and resolve with the first terminal
 *  (non-superseded) response. The export ZIP picks up the rendered HTML
 *  the server caches as a side effect of this convert; we don't render it
 *  here. */
function convertOnce(
  url: string,
  entry: string,
  onStatus: (s: string) => void,
): Promise<ConvertResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const client = new ConvertClient(url, {
      onMessage: (resp: ConvertResponse) => {
        if (settled || resp.status === "superseded") return;
        settled = true;
        client.close();
        resolve(resp);
      },
      onStatus: (s) => {
        if (!settled) onStatus(s);
      },
    });
    client.send({
      id: 1,
      active_file: entry,
      version: 0,
      profile: "fragment",
      format: "html5",
    });
    // Safety net so a silent socket can't hang the form forever.
    window.setTimeout(() => {
      if (settled) return;
      settled = true;
      client.close();
      reject(new Error("conversion timed out"));
    }, 120_000);
  });
}

/** Fetch the session's self-contained export ZIP and trigger a browser
 *  download. Returns a short human description of what was downloaded. */
async function downloadExport(sessionId: string, userId: string): Promise<string> {
  const resp = await fetch(`/api/session/${sessionId}/export-zip`, {
    credentials: "include",
    headers: { [HEADER_USER]: userId },
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `export failed (${resp.status})`);
  }
  const blob = await resp.blob();
  const cd = resp.headers.get("content-disposition") || "";
  const m = /filename="?([^"]+)"?/.exec(cd);
  const filename = m?.[1] ?? "ar5iv-export.zip";

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has grabbed the blob first.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return `${filename} (${fmtBytes(blob.size)})`;
}

let busy = false;

/** Drive one upload → import → convert → export → download cycle. */
async function handleFile(file: File): Promise<void> {
  if (busy) return;
  if (!isAcceptedArchive(file.name)) {
    setStatus("please choose a .zip, .tar.gz, .tgz, or .gz archive");
    return;
  }
  if (file.size > MAX_ARCHIVE_BYTES) {
    setStatus(
      `that archive is ${fmtBytes(file.size)} — the limit is ${fmtBytes(MAX_ARCHIVE_BYTES)}`,
    );
    return;
  }

  busy = true;
  document.body.classList.add("converting");
  hideLog();
  setStatus("uploading…");

  try {
    const userId = await ensureUserId();
    const env = await importArchive(file, userId);

    setStatus("converting…");
    const resp = await convertOnce(websocketUrl(env.id, userId), env.entry, (s) => {
      setStatus(s);
    });

    if (resp.status_code === 4) {
      setStatus("session expired — please upload again");
      showLog(resp.log || "");
      return;
    }

    // The export ZIP only carries an index.html when the conversion
    // actually rendered — the server caches that HTML (for status 0/2,
    // non-empty result) and bundles it as index.html. If nothing rendered
    // (a fatal error, or an empty result), the ZIP would be source-only,
    // so there's nothing worth handing back: print the log to the page and
    // download nothing.
    const rendered =
      (resp.status_code === 0 || resp.status_code === 2) && resp.result.trim().length > 0;
    if (!rendered) {
      setStatus("conversion produced no HTML — see the log below");
      showLog(resp.log || "The converter produced no HTML output.");
      return;
    }

    setStatus("packaging…");
    const what = await downloadExport(env.id, userId);
    // status_code 2 = rendered with non-fatal errors.
    const suffix = resp.status_code === 2 ? " — converted with warnings" : "";
    setStatus(`downloaded ${what}${suffix}`);
    if (resp.status_code === 2 && resp.log) showLog(resp.log);
  } catch (e) {
    setStatus("upload failed");
    showLog(String(e instanceof Error ? e.message : e));
  } finally {
    busy = false;
    document.body.classList.remove("converting");
  }
}

function main(): void {
  const input = document.getElementById("upload-input") as HTMLInputElement | null;
  const drop = document.getElementById("drop-zone");

  input?.addEventListener("change", () => {
    const file = input.files?.[0];
    if (file) void handleFile(file);
    input.value = ""; // allow re-picking the same file
  });

  if (drop) {
    const stop = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    ["dragenter", "dragover"].forEach((name) =>
      drop.addEventListener(name, (ev) => {
        stop(ev);
        drop.classList.add("upload-drop--over");
      }),
    );
    ["dragleave", "dragend"].forEach((name) =>
      drop.addEventListener(name, (ev) => {
        stop(ev);
        drop.classList.remove("upload-drop--over");
      }),
    );
    drop.addEventListener("drop", (ev) => {
      stop(ev);
      drop.classList.remove("upload-drop--over");
      const file = (ev as DragEvent).dataTransfer?.files?.[0];
      if (file) void handleFile(file);
    });
    // Keyboard: the drop zone is a <label for=upload-input>, so Enter/Space
    // already proxy to the file input via label semantics.
  }
}

main();
