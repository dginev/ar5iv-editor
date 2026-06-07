// Standalone validation page (`/validate`): paste or pick a document,
// choose its format (which doubles as the request Content-Type — the
// server maps it to the matching schema preset), POST to
// `/api/validate`, and render the Nu validator's JSON report inline.
// The page is a thin client over the public REST endpoint: everything
// it does is reproducible with curl (see /schemas#validation).

import "./styles.css";

/// Mirrors the route's body cap (35 MB decompressed, lib.rs).
const MAX_DOCUMENT_BYTES = 35 * 1024 * 1024;

interface VnuMessage {
  type: string; // "error" | "info" | "non-document-error"
  subType?: string; // "warning" | "fatal" | ...
  message: string;
  firstLine?: number; // only present when the range spans lines
  lastLine?: number;
  firstColumn?: number;
  lastColumn?: number;
  extract?: string;
}

/// The last-submitted document, split into lines: the report renders
/// each message with a full-width window of the real source (the
/// validator's own `extract` is a ~30-char keyhole) and highlights
/// the reported range inside it.
let lastSourceLines: string[] | null = null;

function el<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
function setStatus(text: string): void {
  el("status").textContent = text;
}

/// Severity bucket for badge styling + the verdict tally.
function severity(m: VnuMessage): "error" | "warning" | "info" {
  if (m.type === "error" || m.type === "non-document-error") return "error";
  if (m.subType === "warning") return "warning";
  return "info";
}

/// Five full-width source rows centred on the message's location,
/// with the reported (1-based, inclusive) column range wrapped in
/// `<mark>`. Returns null when there is no line info or no source.
function renderContext(m: VnuMessage): HTMLElement | null {
  if (lastSourceLines === null || m.lastLine === undefined) return null;
  const total = lastSourceLines.length;
  const endLine = Math.min(m.lastLine, total);
  const startLine = Math.min(m.firstLine ?? endLine, endLine);
  // A 5-row window around the end of the range (vnu anchors the
  // error at lastLine); clamp to the document edges.
  let winStart = Math.max(1, endLine - 2);
  const winEnd = Math.min(total, winStart + 4);
  winStart = Math.max(1, winEnd - 4);

  const ctx = document.createElement("div");
  ctx.className = "validate-msg__context";
  for (let n = winStart; n <= winEnd; n++) {
    const row = document.createElement("div");
    row.className = "validate-ctx__row";
    const gutter = document.createElement("span");
    gutter.className = "validate-ctx__ln";
    gutter.textContent = String(n);
    row.appendChild(gutter);

    const code = document.createElement("span");
    code.className = "validate-ctx__code";
    const text = lastSourceLines[n - 1];
    // Portion of [startLine:firstColumn .. endLine:lastColumn]
    // falling on this row (columns are 1-based and inclusive).
    let hlFrom = -1;
    let hlTo = -1;
    if (n >= startLine && n <= endLine) {
      hlFrom = n === startLine ? (m.firstColumn ?? 1) - 1 : 0;
      hlTo = n === endLine ? (m.lastColumn ?? text.length) : text.length;
    }
    if (hlFrom >= 0 && hlTo > hlFrom && hlFrom < text.length) {
      code.appendChild(document.createTextNode(text.slice(0, hlFrom)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(hlFrom, hlTo);
      code.appendChild(mark);
      code.appendChild(document.createTextNode(text.slice(hlTo)));
    } else {
      code.textContent = text;
    }
    row.appendChild(code);
    ctx.appendChild(row);
  }
  return ctx;
}

function renderReport(messages: VnuMessage[]): void {
  const report = el("validate-report");
  const verdict = el("validate-verdict");
  const list = el<HTMLOListElement>("validate-messages");
  list.textContent = "";

  const errors = messages.filter((m) => severity(m) === "error").length;
  const warnings = messages.filter((m) => severity(m) === "warning").length;

  verdict.textContent =
    errors === 0
      ? warnings === 0
        ? "✓ The document validates."
        : `✓ The document validates (${warnings} warning${warnings === 1 ? "" : "s"}).`
      : `✗ ${errors} error${errors === 1 ? "" : "s"}${warnings ? `, ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`;
  verdict.className = errors === 0 ? "validate-verdict--ok" : "validate-verdict--fail";

  for (const m of messages) {
    const li = document.createElement("li");
    li.className = `validate-msg validate-msg--${severity(m)}`;

    const badge = document.createElement("span");
    badge.className = "validate-msg__badge";
    badge.textContent = severity(m);
    li.appendChild(badge);

    if (m.lastLine !== undefined) {
      const loc = document.createElement("span");
      loc.className = "validate-msg__loc";
      loc.textContent = `line ${m.lastLine}${m.lastColumn !== undefined ? `:${m.lastColumn}` : ""}`;
      li.appendChild(loc);
    }

    const text = document.createElement("span");
    text.className = "validate-msg__text";
    text.textContent = m.message;
    li.appendChild(text);

    const ctx = renderContext(m);
    if (ctx) {
      li.appendChild(ctx);
    } else if (m.extract) {
      // Fallback (no line info / no retained source): the
      // validator's own short extract.
      const extract = document.createElement("code");
      extract.className = "validate-msg__extract";
      extract.textContent = m.extract;
      li.appendChild(extract);
    }

    list.appendChild(li);
  }
  report.hidden = false;
  // Long source rows scroll horizontally; bring each highlight into
  // view (needs layout, so after unhiding).
  for (const ctx of Array.from(list.querySelectorAll<HTMLElement>(".validate-msg__context"))) {
    const mark = ctx.querySelector<HTMLElement>("mark");
    if (mark) ctx.scrollLeft = Math.max(0, mark.offsetLeft - 120);
  }
}

/// Auto-select the format from a chosen file's extension; the user
/// can still override via the dropdown afterwards.
function formatForFilename(name: string): string | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) {
    return "text/html; charset=utf-8";
  }
  if (lower.endsWith(".mml")) return "application/mathml+xml";
  if (lower.endsWith(".xml")) return "application/latexml+xml";
  return null;
}

/// The chosen file's content, held in memory rather than rendered
/// into the textarea — book-sized documents would otherwise bog the
/// page down for no benefit. A chosen file takes precedence over the
/// textarea until removed via the accordion's × button.
let selectedFile: { name: string; text: string } | null = null;

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${n} B`;
}

function clearSelectedFile(): void {
  selectedFile = null;
  el<HTMLInputElement>("validate-file").value = "";
  el("validate-fileinfo").hidden = true;
}

async function validate(): Promise<void> {
  const source = selectedFile?.text ?? el<HTMLTextAreaElement>("validate-source").value;
  if (source.trim().length === 0) {
    setStatus("nothing to validate — paste a document or pick a file");
    return;
  }
  if (new Blob([source]).size > MAX_DOCUMENT_BYTES) {
    setStatus("document exceeds the 35 MB limit");
    return;
  }
  const contentType = el<HTMLSelectElement>("validate-format").value;
  const button = el<HTMLButtonElement>("validate-submit");
  button.disabled = true;
  // Page-wide progress cursor while the request is in flight (same
  // convention as the editor's conversion spinner).
  document.body.classList.add("validate-busy");
  setStatus("validating…");
  el("validate-report").hidden = true;
  try {
    // Compress client-side when the browser can (CompressionStream is
    // universal in modern engines): a book-sized HTML document gzips
    // ~5:1, which matters on slow uplinks. The server's decompression
    // layer is keyed on Content-Encoding.
    const headers: Record<string, string> = { "content-type": contentType };
    let body: BodyInit = source;
    if (typeof CompressionStream !== "undefined") {
      const gz = new Blob([source])
        .stream()
        .pipeThrough(new CompressionStream("gzip"));
      body = await new Response(gz).arrayBuffer();
      headers["content-encoding"] = "gzip";
    }
    const resp = await fetch("/api/validate", {
      method: "POST",
      headers,
      body,
    });
    if (!resp.ok) {
      const detail = await resp.text();
      setStatus(`request failed (${resp.status}): ${detail.slice(0, 200)}`);
      return;
    }
    const report = (await resp.json()) as { messages: VnuMessage[] };
    // Line/column references in the report index into exactly what
    // was sent — retain it for the context windows.
    lastSourceLines = source.split(/\r\n|\r|\n/);
    renderReport(report.messages);
    setStatus("done");
  } catch (e) {
    setStatus(`request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    button.disabled = false;
    document.body.classList.remove("validate-busy");
  }
}

function init(): void {
  el<HTMLFormElement>("validate-form").addEventListener("submit", (ev) => {
    ev.preventDefault();
    void validate();
  });

  el<HTMLInputElement>("validate-file").addEventListener("change", async (ev) => {
    const input = ev.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (file.size > MAX_DOCUMENT_BYTES) {
      setStatus(`${file.name} exceeds the 35 MB limit`);
      input.value = "";
      return;
    }
    selectedFile = { name: file.name, text: await file.text() };
    const fmt = formatForFilename(file.name);
    if (fmt) el<HTMLSelectElement>("validate-format").value = fmt;
    el("validate-filename").textContent = file.name;
    el("validate-filesize").textContent = fmtBytes(file.size);
    el("validate-fileformat").textContent =
      el<HTMLSelectElement>("validate-format").selectedOptions[0]?.textContent?.trim() ??
      "(from the dropdown)";
    el("validate-fileinfo").hidden = false;
    setStatus(`loaded ${file.name} — press Validate`);
  });

  el<HTMLButtonElement>("validate-fileclear").addEventListener("click", (ev) => {
    // Inside <summary>: stop the click from also toggling the accordion.
    ev.preventDefault();
    ev.stopPropagation();
    clearSelectedFile();
    setStatus("file removed — the text box is active again");
  });
}

init();
