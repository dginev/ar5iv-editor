import "./styles.css";
import { createEditor, type EditorTheme } from "./editor.ts";
import { ConvertClient, type ConvertResponse, type Diagnostic } from "./ws.ts";
import { renderResult, showLog, setPreviewTheme } from "./preview.ts";
import { EXAMPLES_LIST } from "./examples.ts";
import {
  SessionClient,
  SessionExpiredError,
  type FileMeta,
  type SessionEnvelope,
} from "./session.ts";
import { bootResizers } from "./resizers.ts";
import { FilePanel } from "./files.ts";
import { showToast } from "./toast.ts";

const PREAMBLE_RE = /^([\s\S]*\\begin\{document\})([\s\S]*)\\end\{document\}([\s\S]*)$/;
const DEBOUNCE_MS = 300;

type ChromeTheme = "paper" | "midnight" | "terminal";

const TEXT_EXTENSIONS = new Set([
  "tex", "sty", "cls", "bib", "bst", "bbl",
  "txt", "md", "csv", "toml", "json", "yaml", "yml", "svg",
]);

function chromeToEditor(t: ChromeTheme | string | undefined): EditorTheme {
  return t === "paper" ? "light" : "dark";
}

function readChromeTheme(): ChromeTheme {
  const t = document.documentElement.dataset.theme;
  return t === "paper" || t === "midnight" || t === "terminal" ? t : "paper";
}

function statusEl(): HTMLElement {
  return document.getElementById("status")!;
}
function logEl(): HTMLElement {
  return document.getElementById("log")!;
}
function timingsEl(): HTMLElement | null {
  return document.getElementById("timings");
}
function charCountEl(): HTMLElement | null {
  return document.getElementById("char-count");
}

function fmtMs(n: number): string {
  return n < 10 ? n.toFixed(1) : Math.round(n).toString();
}

function tierFor(totalMs: number): "ok" | "warn" | "bad" {
  if (totalMs < 2000) return "ok";
  if (totalMs < 5000) return "warn";
  return "bad";
}

function renderTimings(opts: {
  resp: ConvertResponse;
  network_ms: number;
  render_ms: number;
  wall_ms: number;
}): void {
  const el = timingsEl();
  if (!el) return;
  const t = opts.resp.timings;
  type Stage = { key: string; label: string; value: string; tip: string; ms: number; extra?: string };
  const serverStages: Stage[] = [];
  const clientStages: Stage[] = [];
  if (t) {
    serverStages.push({
      key: "startup",
      label: "startup",
      value: `${(t.build_us / 1000).toFixed(2)} ms`,
      ms: t.build_us / 1000,
      tip: "Construct the OxideConverter for this request (load config, allocate session). Microseconds on warm runs.",
    });
    serverStages.push({
      key: "convert",
      label: "TeX → XML",
      value: `${fmtMs(t.convert_ms)} ms`,
      ms: t.convert_ms,
      tip: "Core conversion: digest the TeX source into LaTeXML XML.",
    });
    serverStages.push({
      key: "post",
      label: "XML → HTML5",
      value: `${fmtMs(t.post_ms)} ms`,
      ms: t.post_ms,
      tip: "Post-processing: emit Presentation MathML and run the bundled HTML5 XSLT stylesheet.",
    });
  }
  clientStages.push({
    key: "network",
    label: "network",
    value: `${fmtMs(opts.network_ms)} ms`,
    ms: opts.network_ms,
    tip: "Wire + queueing: client-roundtrip minus server total. Lower bound on WebSocket latency under load.",
  });
  clientStages.push({
    key: "render",
    label: "render",
    value: `${fmtMs(opts.render_ms)} ms`,
    ms: opts.render_ms,
    tip: "Parse the HTML fragment and morph it into the preview pane (idiomorph). Excludes browser layout/paint.",
  });
  clientStages.push({
    key: "total",
    label: "total",
    value: `${fmtMs(opts.wall_ms)} ms`,
    ms: opts.wall_ms,
    tip: "Wall-clock time from sending the request to the rendered preview. Green < 2 s, orange < 5 s, red ≥ 5 s.",
    extra: `tier-${tierFor(opts.wall_ms)}`,
  });

  const contributors = [...serverStages, ...clientStages].filter((s) => s.key !== "total");
  const slowest = contributors.reduce<Stage | null>(
    (best, s) => (best === null || s.ms > best.ms ? s : best),
    null,
  );
  if (slowest) slowest.extra = (slowest.extra ? slowest.extra + " " : "") + "slowest";

  const renderStage = (s: Stage) =>
    `<span class="stage stage--${s.key}${s.extra ? " " + s.extra : ""}" title="${s.tip}"><span class="label">${s.label}</span><span class="value">${s.value}</span></span>`;
  const renderRow = (group: Stage[]) =>
    `<span class="timings-row">${group.map(renderStage).join("")}</span>`;

  el.innerHTML = renderRow(serverStages) + renderRow(clientStages);
}

function splitPreamble(tex: string): { preamble: string | null; body: string } {
  const m = PREAMBLE_RE.exec(tex);
  if (!m) return { preamble: null, body: tex };
  return { preamble: "literal:" + m[1], body: m[2] };
}

function bootExamples(switchExample: (slug: string) => void): void {
  const select = document.getElementById("example-select") as HTMLSelectElement;
  for (const ex of EXAMPLES_LIST) {
    const opt = document.createElement("option");
    opt.value = ex.slug;
    opt.textContent = ex.name;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    const v = select.value;
    if (!v) return;
    switchExample(v);
  });
}

function bootLogToggle(): void {
  const status = document.getElementById("status");
  if (!status) return;
  status.title = "Click to toggle the full conversion log";
  status.addEventListener("click", () => {
    const preview = document.getElementById("preview");
    const log = document.getElementById("log");
    if (!preview || !log) return;
    if (log.hidden) {
      preview.hidden = true;
      log.hidden = false;
    } else {
      log.hidden = true;
      preview.hidden = false;
    }
  });
}

function isTextPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Map a server diagnostic's `severity` to the three values
 *  CodeMirror's lint extension understands. Fatal collapses to
 *  error; info passes through. */
function cmSeverity(s: Diagnostic["severity"]): "info" | "warning" | "error" {
  if (s === "fatal" || s === "error") return "error";
  if (s === "warning") return "warning";
  return "info";
}

/** Render or hide the source-pane header badge that surfaces
 *  unanchored diagnostics (errors that the engine couldn't tie to
 *  a specific line — typically global, anonymous-buffer, or upstream
 *  locator-coverage gaps). The badge shows a circled "!" with a
 *  count and a hover tooltip listing the messages. */
function applyHeaderBadge(unanchored: Diagnostic[]): void {
  const headerEl = document
    .querySelector<HTMLElement>(".pane-source > .pane-header");
  if (!headerEl) return;
  let badge = document.getElementById("diag-badge");
  if (!unanchored.length) {
    if (badge) badge.remove();
    return;
  }
  if (!badge) {
    badge = document.createElement("button");
    badge.id = "diag-badge";
    badge.type = "button";
    badge.className = "diag-badge";
    headerEl.appendChild(badge);
  }
  const errs = unanchored.filter((d) => d.severity === "error" || d.severity === "fatal").length;
  const warns = unanchored.filter((d) => d.severity === "warning").length;
  badge.classList.toggle("diag-badge--error", errs > 0);
  badge.classList.toggle("diag-badge--warn", errs === 0 && warns > 0);
  badge.textContent = `⓵`.replace("⓵", "ⓘ"); // base symbol; replaced below by severity
  // Use a circled "!" for errors, circled "i" for info-only, circled
  // "?" for warning-only. Unicode glyphs picked for legibility at
  // 12 px.
  badge.textContent = errs > 0 ? "❗" : warns > 0 ? "⚠" : "ℹ";
  badge.title = unanchored
    .map((d) => `[${d.severity}] ${d.category}: ${d.message.split("\n")[0]}`)
    .join("\n");
  // Click toggles a popup listing every unanchored diagnostic.
  badge.onclick = () => togglePopup(unanchored);
}

function togglePopup(diags: Diagnostic[]): void {
  let pop = document.getElementById("diag-popup");
  if (pop) {
    pop.remove();
    return;
  }
  pop = document.createElement("div");
  pop.id = "diag-popup";
  pop.className = "diag-popup";
  pop.innerHTML = diags
    .map(
      (d) =>
        `<div class="diag-popup__row diag-popup__row--${d.severity}">` +
        `<span class="diag-popup__sev">[${d.severity}]</span> ` +
        `<span class="diag-popup__cat">${escapeHtml(d.category)}</span>` +
        `<div class="diag-popup__msg">${escapeHtml(d.message)}</div>` +
        `</div>`,
    )
    .join("");
  // Anchor below the badge.
  const badge = document.getElementById("diag-badge");
  if (badge) {
    const rect = badge.getBoundingClientRect();
    pop.style.top = `${rect.bottom + 4}px`;
    pop.style.right = `${window.innerWidth - rect.right}px`;
  }
  document.body.appendChild(pop);
  // Click-outside to dismiss.
  const off = (ev: MouseEvent) => {
    if (!pop?.contains(ev.target as Node) && ev.target !== badge) {
      pop?.remove();
      document.removeEventListener("click", off, true);
    }
  };
  setTimeout(() => document.addEventListener("click", off, true), 0);
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function main(): Promise<void> {
  const initialEditorTheme = chromeToEditor(readChromeTheme());
  setPreviewTheme(initialEditorTheme);

  const host = document.getElementById("codemirror-host");
  if (!host) return;

  const editor = createEditor(host, initialEditorTheme);
  bootResizers();
  bootLogToggle();

  // The chrome theme is owned by the inline script in base.html; listen for
  // its change event and propagate to the editor and preview only.
  window.addEventListener("ar5iv:themechange", (ev) => {
    const detail = (ev as CustomEvent<{ theme: string }>).detail;
    const e = chromeToEditor(detail?.theme);
    editor.setTheme(e);
    setPreviewTheme(e);
  });

  // -----------------------------------------------------------------
  // Session bootstrap.
  // -----------------------------------------------------------------
  let session: SessionClient;
  try {
    session = await SessionClient.open();
  } catch (e) {
    statusEl().textContent = "session bootstrap failed";
    logEl().textContent = String(e);
    showToast(`Could not start a session: ${e}`, "error");
    return;
  }

  // The convert preload list — kept here so the file-panel binary
  // stub and the WS frame agree on what's loaded.
  const PRELOAD = [
    "LaTeX.pool",
    "article.cls",
    "amsmath.sty",
    "amsthm.sty",
    "amstext.sty",
    "amssymb.sty",
    "eucal.sty",
    "[dvipsnames]xcolor.sty",
    "url.sty",
    "hyperref.sty",
    "[ids,mathlexemes]latexml.sty",
  ];

  // Active file in the session, plus the session's last-known
  // `version`. When `activePath` points at a binary, the editor is
  // hidden and the metadata stub is shown instead — convert frames
  // are silently no-ops in that mode (we don't rerun the engine just
  // because the user clicked a graphic).
  let activePath: string | null = session.envelope.entry || "main.tex";
  let lastVersion = 0;

  async function setActiveFile(path: string): Promise<void> {
    if (!isTextPath(path)) {
      showBinaryStub(path);
      activePath = path;
      return;
    }
    hideBinaryStub();
    const body = await session.getText(path);
    editor.openBuffer(path, body);
    activePath = path;
    const cc = charCountEl();
    if (cc) cc.textContent = `${body.length.toLocaleString()} chars`;
  }

  /** Show a metadata stub in the source pane (filename, size, kind,
   *  hint about how to reference it from TeX). Stub element is
   *  created lazily and inserted alongside the codemirror host. */
  function showBinaryStub(path: string): void {
    const pane = document.querySelector<HTMLElement>(".pane-source");
    if (!pane) return;
    let stub = document.getElementById("binary-stub");
    if (!stub) {
      stub = document.createElement("div");
      stub.id = "binary-stub";
      stub.className = "binary-stub";
      pane.appendChild(stub);
    }
    const file = session.envelope.files.find((f: FileMeta) => f.path === path);
    const stem = path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path;
    const noExt = stem.includes(".") ? stem.slice(0, stem.lastIndexOf(".")) : stem;
    const size = file ? fmtBytes(file.size) : "?";
    const ext = stem.includes(".") ? stem.slice(stem.lastIndexOf(".") + 1).toLowerCase() : "";
    let hint = "";
    if (["png", "jpg", "jpeg", "gif", "pdf", "svg", "eps"].includes(ext)) {
      hint = `<code>\\includegraphics{${noExt}}</code>`;
    } else {
      hint = "Binary file — referenced from TeX by name.";
    }
    stub.innerHTML = `
      <div class="binary-stub__title">${escapeHtml(path)}</div>
      <dl class="binary-stub__meta">
        <dt>size</dt><dd>${size}</dd>
        <dt>kind</dt><dd>${ext || "?"}</dd>
      </dl>
      <div class="binary-stub__hint">${hint}</div>
      <a class="binary-stub__download" href="${session.fileUrl(path)}" download="${stem}">Download</a>
    `;
    host!.style.display = "none";
    stub.hidden = false;
  }

  function hideBinaryStub(): void {
    const stub = document.getElementById("binary-stub");
    if (stub) stub.hidden = true;
    host!.style.display = "";
  }

  function escapeHtml(s: string): string {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** Split engine diagnostics into editor-anchored (a `from_line` is
   *  set AND the diagnostic targets the active buffer) and
   *  unanchored (everything else). The active-buffer match accepts
   *  `Anonymous String` (which the literal-source convert path
   *  always reports) as a synonym for the active file. */
  function applyDiagnostics(diags: Diagnostic[]): void {
    const anchored: Array<{
      severity: "info" | "warning" | "error";
      message: string;
      fromLine: number;
      fromCol?: number;
      toLine?: number;
      toCol?: number;
    }> = [];
    const unanchored: Diagnostic[] = [];
    for (const d of diags) {
      const targetsActive =
        d.source === "Anonymous String" || d.source === activePath;
      if (d.from_line && targetsActive) {
        anchored.push({
          severity: cmSeverity(d.severity),
          message: `${d.category}: ${d.message.split("\n")[0]}`,
          fromLine: d.from_line,
          fromCol: d.from_col,
          toLine: d.to_line,
          toCol: d.to_col,
        });
      } else if (d.severity !== "info") {
        // Don't surface raw info messages as banner badges; they're
        // noisy ("strings_allocated", "Conversion complete: …") and
        // not actionable.
        unanchored.push(d);
      }
    }
    editor.setDiagnostics(anchored);
    applyHeaderBadge(unanchored);
  }

  try {
    await setActiveFile(activePath);
  } catch (e) {
    if (e instanceof SessionExpiredError) {
      await session.reopen();
    } else {
      console.error("initial GET failed", e);
      showToast(`Could not load ${activePath}: ${e}`, "error");
    }
  }

  // -----------------------------------------------------------------
  // WS client. Bound to the session at upgrade.
  // -----------------------------------------------------------------
  let client: ConvertClient | null = null;
  let latestSeenId = 0;
  const sentAt = new Map<number, number>();
  const onWsMessage = (resp: ConvertResponse) => {
    if (resp.id < latestSeenId) {
      sentAt.delete(resp.id);
      return;
    }
    if (resp.status === "superseded") {
      sentAt.delete(resp.id);
      return;
    }
    if (resp.status_code === 4) {
      // session_expired — reopen and re-trigger preview.
      statusEl().textContent = "session expired — reopening";
      showToast("Session expired — reopening", "warn");
      void session.reopen().then(() => {
        rebuildWsClient();
        scheduleConvert();
      });
      return;
    }
    latestSeenId = resp.id;
    const t_send = sentAt.get(resp.id);
    sentAt.delete(resp.id);
    const t_recv = performance.now();
    if (resp.status_code === 3) {
      statusEl().textContent = "fatal";
      showLog(resp.log);
      return;
    }
    statusEl().textContent = resp.status || "ok";
    applyDiagnostics(resp.diagnostics ?? []);
    const t_render0 = performance.now();
    renderResult(resp.result);
    const t_render1 = performance.now();
    logEl().textContent = resp.log;

    if (t_send !== undefined) {
      const wall_ms = t_render1 - t_send;
      const server_total = resp.timings?.total_ms ?? 0;
      const network_ms = Math.max(0, t_recv - t_send - server_total);
      const render_ms = t_render1 - t_render0;
      renderTimings({ resp, network_ms, render_ms, wall_ms });
    }
  };

  const rebuildWsClient = (): void => {
    client?.close();
    client = new ConvertClient(session.websocketUrl(), {
      onMessage: onWsMessage,
      onStatus: (s) => {
        statusEl().textContent = s;
      },
    });
  };
  rebuildWsClient();

  // -----------------------------------------------------------------
  // Edit → PUT → convert chain.
  // -----------------------------------------------------------------
  let nextId = 1;
  let timer: number | null = null;
  const scheduleConvert = (): void => {
    if (!client || !activePath || !isTextPath(activePath)) return;
    const id = nextId++;
    sentAt.set(id, performance.now());
    const tex = editor.getSource();
    const { preamble } = splitPreamble(tex);
    client.send({
      id,
      active_file: activePath,
      version: lastVersion,
      preamble: preamble ?? undefined,
      profile: "fragment",
      format: "html5",
      preload: PRELOAD,
    });
    statusEl().textContent = "converting…";
  };

  editor.onChange((path, tex) => {
    const cc = charCountEl();
    if (cc) cc.textContent = `${tex.length.toLocaleString()} chars`;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(async () => {
      timer = null;
      try {
        const ack = await session.putText(path, tex);
        lastVersion = ack.version;
        scheduleConvert();
      } catch (e) {
        if (e instanceof SessionExpiredError) {
          statusEl().textContent = "session expired — reopening";
          await session.reopen();
          rebuildWsClient();
          try {
            const ack2 = await session.putText(path, tex);
            lastVersion = ack2.version;
            scheduleConvert();
          } catch (e2) {
            showToast(`Save failed after reconnect: ${e2}`, "error");
            statusEl().textContent = "save failed";
          }
        } else {
          console.error("PUT failed", e);
          showToast(`Save failed: ${e}`, "error");
          statusEl().textContent = "save failed";
        }
      }
    }, DEBOUNCE_MS);
  });

  // -----------------------------------------------------------------
  // File panel.
  // -----------------------------------------------------------------
  const treeEl = document.getElementById("file-tree");
  const headerEl = document.querySelector<HTMLElement>(".pane-files .pane-actions");
  let filePanel: FilePanel | null = null;
  if (treeEl && headerEl) {
    headerEl.replaceChildren(); // clear the Phase-3 placeholder buttons
    filePanel = new FilePanel({
      treeEl,
      actionsEl: headerEl,
      session,
      editor,
      requestPreview: scheduleConvert,
      reportError: (msg) => showToast(msg, "error"),
      onOpenFile: async (path: string) => {
        // BufferStore preserves the previous buffer's state on
        // switch; we still PUT the active text buffer first so the
        // engine's `\input` resolution sees the latest bytes on
        // disk. Binary buffers (the metadata stub) skip the PUT.
        if (activePath && isTextPath(activePath)) {
          try {
            const ack = await session.putText(activePath, editor.getSource());
            lastVersion = ack.version;
          } catch (e) {
            if (e instanceof SessionExpiredError) throw e;
            console.warn("save-on-switch failed", e);
          }
        }
        await setActiveFile(path);
        scheduleConvert();
      },
      onSessionSwap: (env: SessionEnvelope) => {
        void handleSessionSwap(env);
      },
    });
  }

  async function handleSessionSwap(env: SessionEnvelope): Promise<void> {
    // The new session has its own filesystem; any cached buffers
    // from the previous one are stale (same path → different bytes).
    // Drop them all so `setActiveFile` is forced to GET fresh
    // content. See editor.ts `closeAllBuffers`.
    editor.closeAllBuffers();
    activePath = env.entry || "main.tex";
    try {
      await setActiveFile(activePath);
    } catch (e) {
      console.error("swap GET failed", e);
      showToast(`Could not load ${activePath}: ${e}`, "error");
    }
    rebuildWsClient();
    filePanel?.setSession(env);
    scheduleConvert();
  }

  // Examples dropdown: switch slot, refresh file panel, replace editor,
  // trigger preview.
  bootExamples(async (slug) => {
    try {
      await session.switchSlot(`example:${slug}`);
    } catch (e) {
      console.error("switchSlot failed", e);
      showToast(`Loading example failed: ${e}`, "error");
      statusEl().textContent = "load example failed";
      return;
    }
    await handleSessionSwap(session.envelope);
  });

  // First convert kicks off after the editor has been hydrated and the
  // WS is open. We send eagerly; the convert client queues until the
  // socket is connected.
  scheduleConvert();
}

void main();
