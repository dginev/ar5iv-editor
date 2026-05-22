import "./styles.css";
import { createEditor, type EditorTheme } from "./editor.ts";
import { ConvertClient, type ConvertResponse, type Diagnostic } from "./ws.ts";
import { renderResult, showLog, showEmptyState, setPreviewTheme, setPreviewChromeTheme } from "./preview.ts";
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
  "tex", "sty", "cls", "bib", "bst", "bbl", "def", "ldf",
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

// Mirrors the server's `contains_documentclass` (convert.rs): true iff the
// source contains `\documentclass` outside a comment. Used to decide
// preload shape — a full document loads its own packages, so we only
// need ar5iv.sty in front; a fragment needs the article-class chain too.
function hasDocumentclass(tex: string): boolean {
  for (const line of tex.split("\n")) {
    const trimmed = line.replace(/^\s+/, "");
    if (trimmed.startsWith("%")) continue;
    const idx = trimmed.indexOf("\\documentclass");
    if (idx >= 0 && !trimmed.slice(0, idx).includes("%")) return true;
  }
  return false;
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

/** Pick the file the editor should show right after a fresh
 *  `SessionEnvelope` arrives (initial bootstrap, slot switch, swap).
 *  Returns `null` when the session is genuinely empty (the "New
 *  Project" slot, or a slot whose only example has no usable text
 *  files) — callers must skip the GET in that case. Falls back to
 *  the envelope's `entry` hint, then to whatever text file is first
 *  in the listing. */
function pickInitialActivePath(env: SessionEnvelope): string | null {
  if (env.files.length === 0) return null;
  if (env.entry) return env.entry;
  return env.files.find((f) => f.kind === "text")?.path ?? null;
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

interface VersionInfo {
  latexml_oxide: { sha: string; date: string; url: string };
}

/** Fetch `/api/version` and render a right-aligned link in the
 *  preview-pane header so the user always knows which latexml-oxide
 *  build the conversion backend is running. The link points at the
 *  exact commit's tree on GitHub when the SHA is known. */
async function bootVersionMarker(): Promise<void> {
  const headerEl = document.querySelector<HTMLElement>(
    ".pane-preview > .pane-header",
  );
  if (!headerEl) return;
  try {
    const resp = await fetch("/api/version");
    if (!resp.ok) return;
    const v = (await resp.json()) as VersionInfo;
    const a = document.createElement("a");
    a.className = "preview-version";
    a.href = v.latexml_oxide.url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.title = `latexml-oxide build at commit ${v.latexml_oxide.sha} (${v.latexml_oxide.date})`;
    a.textContent = `latexml-oxide ${v.latexml_oxide.date} · ${v.latexml_oxide.sha}`;
    headerEl.appendChild(a);
  } catch (e) {
    console.warn("version fetch failed", e);
  }
}

async function main(): Promise<void> {
  const initialChromeTheme = readChromeTheme();
  const initialEditorTheme = chromeToEditor(initialChromeTheme);
  setPreviewTheme(initialEditorTheme);
  setPreviewChromeTheme(initialChromeTheme);

  const host = document.getElementById("codemirror-host");
  if (!host) return;

  const editor = createEditor(host, initialEditorTheme);
  bootResizers();
  bootLogToggle();
  void bootVersionMarker();

  // The chrome theme is owned by the inline script in base.html; listen for
  // its change event and propagate to the editor and preview only.
  window.addEventListener("ar5iv:themechange", (ev) => {
    const detail = (ev as CustomEvent<{ theme: string }>).detail;
    const e = chromeToEditor(detail?.theme);
    editor.setTheme(e);
    setPreviewTheme(e);
    if (detail?.theme) setPreviewChromeTheme(detail.theme);
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
  // ar5iv.sty must come FIRST: it calls `pass_options("latexml", "sty", …,
  // tokenlimit=249999999)` before requiring latexml.sty. Once anything else
  // in the preload list triggers a latexml.sty load (article.cls and the
  // amsmath family do), the higher token limit can no longer be passed in.
  //
  // For fragment input (no \documentclass), we also preload the article
  // class + the common math/color/link packages so the snippet renders
  // without the user having to declare them. For full documents
  // (\documentclass present) the source loads what it needs itself —
  // we only need to ensure ar5iv.sty is in place first.
  const PRELOAD_AR5IV_ONLY = ["ar5iv.sty"];
  const PRELOAD_FRAGMENT = [
    "ar5iv.sty",
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
  ];

  // Active file in the session, plus the session's last-known
  // `version`. When `activePath` points at a binary, the editor is
  // hidden and the metadata stub is shown instead — convert frames
  // are silently no-ops in that mode (we don't rerun the engine just
  // because the user clicked a graphic). `null` while the session
  // has no files yet (e.g. the "New Project" slot before the first
  // upload) — the UI sits idle until something lands in the tree.
  let activePath: string | null = pickInitialActivePath(session.envelope);
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

  /** Does this diagnostic target the active buffer? The engine
   *  emits the source as the file stem (e.g. `"full_article"` for
   *  `full_article.tex`), or as `"Anonymous String"` for literal
   *  source. Try several normal forms. */
  function matchesActiveBuffer(source: string | undefined): boolean {
    if (!source) return false;
    if (source === "Anonymous String") return true;
    if (source === activePath) return true;
    // Strip extension (`full_article.tex` → `full_article`).
    const dot = activePath.lastIndexOf(".");
    const stem = dot >= 0 ? activePath.slice(0, dot) : activePath;
    if (source === stem) return true;
    // Strip any directory prefix on top of that — engine usually
    // reports just the stem name.
    const slash = stem.lastIndexOf("/");
    const baseStem = slash >= 0 ? stem.slice(slash + 1) : stem;
    if (source === baseStem) return true;
    return false;
  }

  /** Split engine diagnostics into editor-anchored (a `from_line` is
   *  set AND the diagnostic targets the active buffer) and
   *  unanchored (everything else). */
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
      if (d.severity === "info") {
        // Info-level entries ("Conversion complete: …",
        // "strings_allocated", etc.) are noisy and never actionable.
        // Drop them from both buckets.
        continue;
      }
      if (d.from_line && matchesActiveBuffer(d.source)) {
        anchored.push({
          severity: cmSeverity(d.severity),
          message: `${d.category}: ${d.message.split("\n")[0]}`,
          fromLine: d.from_line,
          fromCol: d.from_col,
          toLine: d.to_line,
          toCol: d.to_col,
        });
      } else {
        unanchored.push(d);
      }
    }
    editor.setDiagnostics(anchored);
    applyHeaderBadge(unanchored);
  }

  if (activePath !== null) {
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
  }

  // -----------------------------------------------------------------
  // WS client. Bound to the session at upgrade.
  // -----------------------------------------------------------------
  let client: ConvertClient | null = null;
  let latestSeenId = 0;
  const sentAt = new Map<number, number>();
  /** Toggle every "convert in flight" affordance based on
   *  `sentAt.size`: the preview-pane diagonal-stripe watermark and a
   *  page-wide `progress` cursor on the body. Driven by `sentAt.size`
   *  so it survives whatever weird mix of in-flight, superseded, and
   *  fatal responses the WS happens to be juggling. */
  const syncLoadingIndicator = (): void => {
    const busy = sentAt.size > 0;
    document.getElementById("preview")
      ?.classList.toggle("preview--loading", busy);
    document.body.classList.toggle("converting", busy);
  };
  /** Live "converting (Xs)" elapsed-time counter. Big arXiv papers
   *  routinely take 5-15 s server-side; without a visible counter the
   *  page reads as frozen even though the WS is still alive. The
   *  timer starts when sentAt transitions empty → non-empty and
   *  stops when it transitions back. */
  let convertStartedAt: number | null = null;
  let convertTickerId: number | null = null;
  const startConvertTicker = (): void => {
    if (convertTickerId !== null) return;
    convertStartedAt = performance.now();
    const tick = () => {
      if (convertStartedAt === null) return;
      const s = ((performance.now() - convertStartedAt) / 1000).toFixed(1);
      statusEl().textContent = `converting… (${s}s)`;
    };
    tick();
    convertTickerId = window.setInterval(tick, 250);
  };
  const stopConvertTicker = (): void => {
    if (convertTickerId !== null) {
      window.clearInterval(convertTickerId);
      convertTickerId = null;
    }
    convertStartedAt = null;
  };
  /** Hard-clear the watermark, regardless of `sentAt.size`. Called
   *  whenever fresh content lands in the preview pane: the user is
   *  now looking at a current render, so the watermark MUST come off
   *  even if some older request's `sentAt` slot is orphaned (the WS
   *  handler's tokio::select cancellation path drops cancelled
   *  requests silently — no "superseded" reply — so those slots
   *  never settle on their own). */
  const clearLoadingIndicator = (): void => {
    document.getElementById("preview")?.classList.remove("preview--loading");
    document.body.classList.remove("converting");
  };
  /** Drop every `sentAt` entry older than `beforeId`. Those requests
   *  were either responded to in some earlier branch or silently
   *  cancelled by a newer one; either way they will not produce a
   *  fresh response and would otherwise keep the watermark on
   *  forever via `syncLoadingIndicator`. */
  const sweepStaleSentAt = (beforeId: number): void => {
    for (const id of [...sentAt.keys()]) {
      if (id < beforeId) sentAt.delete(id);
    }
  };
  // Each entry maps a convert request id to a callback that resolves
  // its `awaitRender` promise. Used by the example-swap chain (and
  // any other caller that needs to know "this convert has either
  // rendered or is permanently lost") to serialize against rapid
  // re-clicks. Settled in *every* branch of `onWsMessage` so callers
  // never wedge — even on fatal / session-expired / superseded.
  const awaitingRender = new Map<number, () => void>();
  const settleAwaiter = (id: number): void => {
    const cb = awaitingRender.get(id);
    if (cb) {
      awaitingRender.delete(id);
      cb();
    }
  };
  const awaitRender = (id: number, timeoutMs = 30_000): Promise<void> => {
    return new Promise<void>((resolve) => {
      const t = window.setTimeout(() => {
        awaitingRender.delete(id);
        resolve();
      }, timeoutMs);
      awaitingRender.set(id, () => {
        window.clearTimeout(t);
        resolve();
      });
    });
  };
  const onWsMessage = (resp: ConvertResponse) => {
    if (resp.id < latestSeenId) {
      sentAt.delete(resp.id);
      syncLoadingIndicator();
      if (sentAt.size === 0) stopConvertTicker();
      settleAwaiter(resp.id);
      return;
    }
    if (resp.status === "superseded") {
      sentAt.delete(resp.id);
      syncLoadingIndicator();
      if (sentAt.size === 0) stopConvertTicker();
      settleAwaiter(resp.id);
      return;
    }
    if (resp.status_code === 4) {
      // session_expired — reopen and re-trigger preview.
      statusEl().textContent = "session expired — reopening";
      showToast("Session expired — reopening", "warn");
      settleAwaiter(resp.id);
      // Don't clear the loading indicator here: we're about to fire a
      // fresh convert which will re-add it anyway, and clearing in the
      // meantime would flicker the stripes off for one frame.
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
      syncLoadingIndicator();
      if (sentAt.size === 0) stopConvertTicker();
      settleAwaiter(resp.id);
      return;
    }
    statusEl().textContent = resp.status || "ok";
    applyDiagnostics(resp.diagnostics ?? []);
    const t_render0 = performance.now();
    renderResult(resp.result);
    const t_render1 = performance.now();
    logEl().textContent = resp.log;
    // Drop any orphaned older slots (cancelled requests that the WS
    // handler quietly dropped). Then hard-clear the watermark — the
    // pane now shows current content, so the indicator MUST be off
    // even if a still-pending newer request is in flight; that newer
    // request will re-add the indicator via syncLoadingIndicator() on
    // the next scheduleConvert if it fires after this render.
    sweepStaleSentAt(resp.id);
    clearLoadingIndicator();
    syncLoadingIndicator();
    if (sentAt.size === 0) stopConvertTicker();

    if (t_send !== undefined) {
      const wall_ms = t_render1 - t_send;
      const server_total = resp.timings?.total_ms ?? 0;
      const network_ms = Math.max(0, t_recv - t_send - server_total);
      const render_ms = t_render1 - t_render0;
      renderTimings({ resp, network_ms, render_ms, wall_ms });
    }
    settleAwaiter(resp.id);
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
  /** Paint the preview pane's "no .tex to render" placeholder when
   *  the session has no convertible source file. Idempotent — safe
   *  to call from any code path that just changed the file set. */
  const maybeShowEmptyState = (): void => {
    const hasTex = session.envelope.files.some(
      (f) => f.path.toLowerCase().endsWith(".tex"),
    );
    if (!hasTex) {
      showEmptyState(
        "No .tex file in this project — create or upload one to render.",
      );
      statusEl().textContent = "ready";
    }
  };
  /** Returns the request id we sent (so callers like the example-swap
   *  chain can `awaitRender(id)` to know when this particular convert
   *  has either rendered or been definitively given up on), or `null`
   *  when the convert was skipped:
   *    - no WS client (boot in flight)
   *    - no active path
   *    - active buffer isn't a `.tex` (the engine only parses TeX —
   *      sending a JSON / Markdown / SVG buffer surfaces as bogus
   *      diagnostics; a quiet skip is the right answer)
   *    - active path was deleted out from under us and no
   *      replacement has been picked yet (would otherwise surface as
   *      "active_file: No such file or directory" server-side) */
  const scheduleConvert = (): number | null => {
    if (!client || !activePath) {
      maybeShowEmptyState();
      return null;
    }
    if (!activePath.toLowerCase().endsWith(".tex")) {
      maybeShowEmptyState();
      return null;
    }
    if (!session.envelope.files.some((f) => f.path === activePath)) {
      activePath = null;
      maybeShowEmptyState();
      return null;
    }
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
      preload: hasDocumentclass(tex) ? PRELOAD_AR5IV_ONLY : PRELOAD_FRAGMENT,
    });
    statusEl().textContent = "converting…";
    startConvertTicker();
    syncLoadingIndicator();
    return id;
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
        // disk whenever the next convert fires. Binary buffers (the
        // metadata stub) skip the PUT.
        //
        // Skip the save when the prior active path is no longer in
        // the session's file list — that's the file-just-deleted
        // path, where the FilePanel has cleared its active and is
        // auto-opening the replacement. PUTing here would recreate
        // the file we just removed (with whatever stale text the
        // editor still holds), and `find_main_tex` would happily
        // pick it back up as the project's main entry.
        //
        // Note: switching files does NOT trigger a convert. The
        // server's `find_main_tex` always renders the project's main
        // entrypoint regardless of which file the editor displays —
        // re-rendering on every navigation click would be wasted
        // work. Conversions are driven only by events that change
        // *what* gets rendered: edits (via the debounce), file-set
        // mutations (upload / delete / clear / new file), and
        // example swaps.
        const stillExists = !!activePath
          && session.envelope.files.some((f) => f.path === activePath);
        if (activePath && isTextPath(activePath) && stillExists) {
          try {
            const ack = await session.putText(activePath, editor.getSource());
            lastVersion = ack.version;
          } catch (e) {
            if (e instanceof SessionExpiredError) throw e;
            console.warn("save-on-switch failed", e);
          }
        }
        await setActiveFile(path);
      },
      onSessionSwap: (env: SessionEnvelope) => {
        void handleSessionSwap(env);
      },
    });
  }

  async function handleSessionSwap(env: SessionEnvelope): Promise<number | null> {
    // The new session has its own filesystem; any cached buffers
    // from the previous one are stale (same path → different bytes).
    // Drop them all so `setActiveFile` is forced to GET fresh
    // content. See editor.ts `closeAllBuffers`.
    editor.closeAllBuffers();
    activePath = pickInitialActivePath(env);
    if (activePath !== null) {
      try {
        await setActiveFile(activePath);
      } catch (e) {
        console.error("swap GET failed", e);
        showToast(`Could not load ${activePath}: ${e}`, "error");
      }
    }
    rebuildWsClient();
    filePanel?.setSession(env);
    return scheduleConvert();
  }

  // Examples dropdown: switch slot, refresh file panel, replace
  // editor, trigger preview. Swaps are *serialized* via `swapChain`
  // because rebuildWsClient() during a still-pending convert closes
  // the WS before the response can arrive — so back-to-back clicks
  // would leave the preview blank. Each swap awaits its own convert
  // response (or a 30s timeout) before releasing the chain.
  let swapChain: Promise<void> = Promise.resolve();
  bootExamples((slug) => {
    swapChain = swapChain.then(async () => {
      try {
        await session.switchSlot(`example:${slug}`);
      } catch (e) {
        console.error("switchSlot failed", e);
        showToast(`Loading example failed: ${e}`, "error");
        statusEl().textContent = "load example failed";
        return;
      }
      const id = await handleSessionSwap(session.envelope);
      if (id !== null) await awaitRender(id);
    });
  });

  // First convert kicks off after the editor has been hydrated and the
  // WS is open. We send eagerly; the convert client queues until the
  // socket is connected.
  scheduleConvert();
}

void main();
