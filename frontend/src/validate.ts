// Standalone validation page (`/validate`): paste or pick a document,
// choose its format (which doubles as the request Content-Type — the
// server maps it to the matching schema preset), POST to
// `/api/validate`, and render the Nu validator's JSON report inline.
// The page is a thin client over the public REST endpoint: everything
// it does is reproducible with curl (see /schemas#validation).

import "./styles.css";

/// Mirrors the route's body cap (20 MB decompressed, lib.rs).
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

interface VnuMessage {
  type: string; // "error" | "info" | "non-document-error"
  subType?: string; // "warning" | "fatal" | ...
  message: string;
  lastLine?: number;
  firstColumn?: number;
  lastColumn?: number;
  extract?: string;
}

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

    if (m.extract) {
      const extract = document.createElement("code");
      extract.className = "validate-msg__extract";
      extract.textContent = m.extract;
      li.appendChild(extract);
    }

    list.appendChild(li);
  }
  report.hidden = false;
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
    setStatus("document exceeds the 20 MB limit");
    return;
  }
  const contentType = el<HTMLSelectElement>("validate-format").value;
  const button = el<HTMLButtonElement>("validate-submit");
  button.disabled = true;
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
    renderReport(report.messages);
    setStatus("done");
  } catch (e) {
    setStatus(`request failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    button.disabled = false;
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
      setStatus(`${file.name} exceeds the 20 MB limit`);
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
