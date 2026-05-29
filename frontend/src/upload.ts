// Standalone archive-conversion page (`/upload`): ZIP-to-ZIP, no preview.
//
// Drop a self-sufficient LaTeX archive (.zip / .tar.gz / .tgz / .gz). It's
// imported into a fresh session via `POST /api/import-archive`, then
// `GET /api/session/{id}/archive` runs the conversion server-side and
// streams back a self-contained HTML5 ZIP — produced by latexml-oxide's
// native `whatsout=archive` packer (rendered HTML + the engine's
// generated/copied resources, no uploaded sources). When a conversion
// renders nothing the server returns the log (422), which we print on the
// page. No preview, no WebSocket — pure archive-in / archive-out glue.

import "./styles.css";

// Matches the server's default archive cap (`quota_archive_bytes`,
// config.rs). Client-side reject before the upload so the user gets an
// immediate, friendly message instead of a 413 after a long transfer.
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;

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

/** Advisory Content-Type — the server believes the magic bytes, not this. */
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

type ArchiveResult =
  | { kind: "downloaded"; what: string }
  | { kind: "no-render"; log: string };

/** Convert the session into a self-contained ZIP and trigger a download.
 *  A `422` means the conversion rendered nothing — the body is the log,
 *  which the caller shows on the page instead of downloading. */
async function downloadArchive(sessionId: string, userId: string): Promise<ArchiveResult> {
  const resp = await fetch(`/api/session/${sessionId}/archive`, {
    credentials: "include",
    headers: { [HEADER_USER]: userId },
  });
  if (resp.status === 422) {
    const log = await resp.text();
    return { kind: "no-render", log: log || "The converter produced no output." };
  }
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(text || `archive failed (${resp.status})`);
  }

  const blob = await resp.blob();
  const cd = resp.headers.get("content-disposition") || "";
  const m = /filename="?([^"]+)"?/.exec(cd);
  const filename = m?.[1] ?? "ar5iv-archive.zip";

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has grabbed the blob first.
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  return { kind: "downloaded", what: `${filename} (${fmtBytes(blob.size)})` };
}

let busy = false;

/** Drive one upload → import → convert → download cycle. */
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
    const res = await downloadArchive(env.id, userId);
    if (res.kind === "downloaded") {
      setStatus(`downloaded ${res.what}`);
    } else {
      setStatus("conversion produced no HTML — see the log below");
      showLog(res.log);
    }
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
