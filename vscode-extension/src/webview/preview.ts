// ar5iv VS Code preview webview script.
//
// Runs inside the webview iframe (Chromium, in both desktop Electron and
// browser VS Code). This is the VS Code adapter over the shared preview core
// (`frontend-core/`) — the same core powers `/editor`. It supplies only the
// VS Code specifics: the theme-var color mapping, the `asWebviewUri` stylesheet
// URLs (injected via the bootstrap JSON), the idiomorph render, and the toolbar
// / status / timings chrome around the preview. The source-map sync (both
// directions) and shadow-DOM rendering all live in the core.
import { Idiomorph } from "idiomorph";
import { createPreview, type PreviewController, type SourceNavTarget } from "../../../frontend-core/index";

// ---------------------------------------------------------------------------
// Webview ↔ extension message protocol.
// ---------------------------------------------------------------------------
interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

interface RequestMeta {
  id: number;
  revision: number;
  activeFile: string;
  activeUri: string;
  cursor?: { line: number; column: number; token?: string };
}

interface Timings {
  buildUs?: number;
  convertMs?: number;
  postMs?: number;
  totalMs?: number;
  networkMs?: number;
}

interface ConverterVersion {
  name: string;
  version?: string;
  sha?: string;
  date?: string;
  url?: string;
}

interface ConvertResponse {
  id: number;
  revision: number;
  status: string;
  statusCode: number;
  engineStatus?: string;
  html: string;
  diagnostics?: { severity: string }[];
  sources?: string[];
  log: string;
  timings?: Timings;
  converter?: ConverterVersion;
}

type HostMessage =
  | { type: "pending"; request: RequestMeta }
  | { type: "result"; request: RequestMeta; response: ConvertResponse }
  | { type: "error"; message: string }
  | { type: "empty"; message: string };

const vscode = acquireVsCodeApi();

const bootstrap: { ar5ivCssUri: string; fontsCssUri: string } = JSON.parse(
  document.getElementById("ar5iv-bootstrap")?.textContent || "{}",
);

// Map ar5iv color tokens onto the VS Code webview theme variables, so the
// preview surface tracks the active color theme the way `/editor`'s preview
// tracks its chrome theme. Each mapping keeps the ar5iv default as a fallback;
// `--ar5iv-sync-color` (consumed by the core's arrival flash) is the link color.
const HOST_TOKEN_CSS = `
  :host {
    --background-color:       var(--vscode-editor-background, white);
    --text-color:             var(--vscode-editor-foreground, #292929);
    --border-color:           var(--vscode-editor-foreground, #292929);
    --border-light-color:     var(--vscode-panel-border, grey);
    --link-text-color:        var(--vscode-editor-foreground, #212121);
    --email-link-color:       var(--vscode-textLink-foreground, #026ecb);
    --note-mark-color:        var(--vscode-textLink-foreground, #026ecb);
    --note-highlight-color:   var(--vscode-editor-findMatchHighlightBackground, #ffffd4);
    --info-text-color:        var(--vscode-textLink-foreground, #01719d);
    --warning-text-color:     var(--vscode-editorWarning-foreground, #d09e05);
    --error-text-color:       var(--vscode-errorForeground, #d8000c);
    --ar5iv-sync-color:       var(--vscode-textLink-foreground, #026ecb);
  }
  /* Override ar5iv.css's hard-coded dark palette ([data-theme="dark"]) with the
     VS Code theme's own dark values via an ID-qualified selector (higher
     specificity). --image-color / --image-background-color stay at ar5iv's dark
     defaults (per-image filter inversion, independent of chrome theming). */
  #preview-root-host[data-theme="dark"] {
    --background-color:    var(--vscode-editor-background, #0d1117);
    --text-color:          var(--vscode-editor-foreground, #c9d1d9);
    --border-color:        var(--vscode-editor-foreground, #c9d1d9);
    --border-light-color:  var(--vscode-panel-border, #292929);
    --link-text-color:     var(--vscode-editor-foreground, #c9d1d9);
    --email-link-color:    var(--vscode-textLink-foreground, #58a6ff);
    --note-mark-color:     var(--vscode-textLink-foreground, #58a6ff);
    --note-highlight-color: var(--vscode-editor-findMatchHighlightBackground, #3a2a00);
    --info-text-color:     var(--vscode-textLink-foreground, #58a6ff);
    --warning-text-color:  var(--vscode-editorWarning-foreground, #d29922);
    --error-text-color:    var(--vscode-errorForeground, #f85149);
  }
`;

const preview: PreviewController = createPreview({
  container: document.getElementById("preview")!,
  hostTokenCss: HOST_TOKEN_CSS,
  cssLinks:
    `<link rel="stylesheet" href="${bootstrap.fontsCssUri}">` +
    `<link rel="stylesheet" href="${bootstrap.ar5ivCssUri}">`,
  morph: (host, incoming) => Idiomorph.morph(host, incoming, { morphStyle: "innerHTML" }),
});

// ---------------------------------------------------------------------------
// Toolbar + status + timings chrome (light DOM, outside the shadow root).
// ---------------------------------------------------------------------------
const titleEl = document.getElementById("title")!;
const statusEl = document.getElementById("status")!;
const timingsEl = document.getElementById("timings")!;
const versionEl = document.getElementById("version")! as HTMLAnchorElement;
const logEl = document.getElementById("log")! as HTMLPreElement;
const previewEl = document.getElementById("preview")!;
const refreshBtn = document.getElementById("btn-refresh")!;
const logBtn = document.getElementById("btn-log")!;

let latest: { request: RequestMeta; response: ConvertResponse } | null = null;
let logVisible = false;

// Live "converting (Xs)" elapsed counter — big arXiv papers take seconds
// server-side; without it the panel reads as frozen.
let convertStartedAt: number | null = null;
let convertTicker: number | null = null;
function startTicker(): void {
  if (convertTicker !== null) return;
  convertStartedAt = performance.now();
  const tick = () => {
    if (convertStartedAt === null) return;
    const s = ((performance.now() - convertStartedAt) / 1000).toFixed(1);
    statusEl.textContent = `converting… (${s}s)`;
    statusEl.dataset.kind = "";
  };
  tick();
  convertTicker = window.setInterval(tick, 100);
}
function stopTicker(): void {
  if (convertTicker !== null) {
    window.clearInterval(convertTicker);
    convertTicker = null;
  }
  convertStartedAt = null;
}

function setBusy(busy: boolean): void {
  previewEl.classList.toggle("loading", busy);
}

function fmtMs(n: number): string {
  return n < 10 ? n.toFixed(1) : Math.round(n).toString();
}

function tierFor(totalMs: number): "ok" | "warn" | "bad" {
  if (totalMs < 2000) return "ok";
  if (totalMs < 5000) return "warn";
  return "bad";
}

interface Stage {
  key: string;
  label: string;
  value: string;
  ms: number;
}

function stageSpan(key: string, label: string, value: string, extra = ""): string {
  return `<span class="stage stage--${key}${extra ? " " + extra : ""}"><span class="label">${label}</span><span class="value">${value}</span></span>`;
}

/** Per-stage timing breakdown, mirroring /editor: server stages (startup,
 *  TeX→XML, XML→HTML5), then client stages (network wire, render), then the
 *  wall-clock total. The slowest contributor is emphasized; the total is
 *  tier-colored. `wireMs` is wire/queue latency (round-trip minus server
 *  total); `wallMs` is the full client-perceived time. */
function renderTimings(t: Timings | undefined, wireMs: number, renderMs: number, wallMs: number): void {
  const stages: Stage[] = [];
  if (t?.buildUs !== undefined) stages.push({ key: "startup", label: "startup", value: `${(t.buildUs / 1000).toFixed(2)} ms`, ms: t.buildUs / 1000 });
  if (t?.convertMs !== undefined) stages.push({ key: "convert", label: "TeX → XML", value: `${fmtMs(t.convertMs)} ms`, ms: t.convertMs });
  if (t?.postMs !== undefined) stages.push({ key: "post", label: "XML → HTML5", value: `${fmtMs(t.postMs)} ms`, ms: t.postMs });
  stages.push({ key: "network", label: "network", value: `${fmtMs(wireMs)} ms`, ms: wireMs });
  stages.push({ key: "render", label: "render", value: `${fmtMs(renderMs)} ms`, ms: renderMs });

  let slowest: Stage | undefined;
  for (const stage of stages) if (!slowest || stage.ms > slowest.ms) slowest = stage;

  const parts = stages.map((stage) => stageSpan(stage.key, stage.label, stage.value, stage === slowest ? "slowest" : ""));
  parts.push(stageSpan("total", "total", `${fmtMs(wallMs)} ms`, `tier-${tierFor(wallMs)}`));
  timingsEl.innerHTML = parts.join("");
}

function renderVersion(converter: ConverterVersion | undefined): void {
  if (!converter || (!converter.sha && !converter.date)) {
    versionEl.hidden = true;
    return;
  }
  versionEl.hidden = false;
  versionEl.href = converter.url || "#";
  const name = converter.name || "latexml-oxide";
  const meta = [converter.date, converter.sha].filter(Boolean).join(" · ");
  const label = meta ? `${name} ${meta}` : name;
  versionEl.textContent = label;
  versionEl.title = `Conversion backend: ${label}`;
}

/** Non-info diagnostics only — info-level entries (engine chatter like
 *  `strings_allocated`, source-map notes) are noise, matching the web editor. */
function actionableDiagnostics(response: ConvertResponse): number {
  return (response.diagnostics ?? []).filter((d) => d.severity !== "info").length;
}

function statusSummary(response: ConvertResponse): string {
  // Prefer the engine's own label ("ok", "1 warning", "2 errors"); the
  // actionable diagnostic count is already implied by it, so don't double-count.
  const base = response.engineStatus || response.status || "done";
  const diags = actionableDiagnostics(response);
  if (diags && !/\d/.test(base)) return `${base} · ${diags} diagnostic${diags === 1 ? "" : "s"}`;
  return base;
}

/** Status-line tier from the engine status code: 0 clean, 1 warning, 2 errors
 *  (all rendered), 3 fatal. */
function statusKind(response: ConvertResponse): string {
  if (response.statusCode === 3 || response.status === "fatal") return "fatal";
  if (response.statusCode === 2) return "error";
  if (response.statusCode === 1 || actionableDiagnostics(response) > 0) return "warning";
  return "ok";
}

function setLogVisible(visible: boolean): void {
  logVisible = visible;
  logEl.hidden = !visible;
  previewEl.hidden = visible;
  logBtn.setAttribute("aria-pressed", String(visible));
  logBtn.classList.toggle("active", visible);
}

function showError(message: string): void {
  stopTicker();
  setBusy(false);
  statusEl.textContent = "error";
  statusEl.dataset.kind = "fatal";
  timingsEl.textContent = "";
  logEl.textContent = message;
  setLogVisible(true);
}

window.addEventListener("message", (event) => {
  const message = event.data as HostMessage;
  if (!message || typeof message.type !== "string") return;

  if (message.type === "pending") {
    titleEl.textContent = message.request.activeFile || "ar5iv Preview";
    setBusy(true);
    startTicker();
    return;
  }
  if (message.type === "empty") {
    stopTicker();
    setBusy(false);
    statusEl.textContent = "ready";
    statusEl.dataset.kind = "";
    timingsEl.textContent = "";
    setLogVisible(false);
    preview.showEmptyState(message.message);
    return;
  }
  if (message.type === "error") {
    showError(message.message);
    return;
  }
  if (message.type === "result") {
    handleResult(message.request, message.response);
    return;
  }
});

function handleResult(request: RequestMeta, response: ConvertResponse): void {
  stopTicker();
  setBusy(false);
  latest = { request, response };
  titleEl.textContent = request.activeFile || "ar5iv Preview";
  logEl.textContent = response.log || "";
  renderVersion(response.converter);

  if (response.statusCode === 3 || (!response.html && response.status === "fatal")) {
    statusEl.textContent = "fatal";
    statusEl.dataset.kind = "fatal";
    timingsEl.textContent = "";
    setLogVisible(true);
    return;
  }

  statusEl.textContent = statusSummary(response);
  statusEl.dataset.kind = statusKind(response);

  // Keep the log view if the user pinned it open; otherwise show the preview.
  if (!logVisible) setLogVisible(false);

  const t0 = performance.now();
  if (response.html) {
    preview.renderResult(response.html);
  } else {
    preview.showEmptyState(response.log || statusSummary(response));
  }
  const renderMs = performance.now() - t0;
  // The provider's networkMs is the full client round-trip (PUT + WS); wire
  // latency is that minus the server total, and the wall total adds render.
  const roundTrip = response.timings?.networkMs ?? 0;
  const serverTotal = response.timings?.totalMs ?? 0;
  const wireMs = Math.max(0, roundTrip - serverTotal);
  const wallMs = roundTrip + renderMs;
  renderTimings(response.timings, wireMs, renderMs, wallMs);

  if (request.cursor) {
    preview.scrollToSource(
      request.cursor.line,
      request.cursor.column,
      request.cursor.token ?? "",
      request.activeFile,
      response.sources,
    );
  }
}

// Reverse nav: the core resolves tag/word in the webview; the extension reveals
// the position (it owns the documents + source text for recovery).
preview.bindSourceNav((loc: SourceNavTarget) => {
  if (!latest) return;
  vscode.postMessage({
    type: "revealSource",
    payload: {
      ...loc,
      sources: latest.response.sources ?? [],
      activeUri: latest.request.activeUri,
    },
  });
});

refreshBtn.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
logBtn.addEventListener("click", () => setLogVisible(!logVisible));
statusEl.addEventListener("click", () => setLogVisible(!logVisible));

// ---------------------------------------------------------------------------
// Theme tracking. VS Code tags <body> with vscode-light / vscode-dark /
// vscode-high-contrast(-light); map non-light kinds to ar5iv's dark palette.
// ---------------------------------------------------------------------------
function currentThemeKind(): "light" | "dark" {
  const cls = document.body.classList;
  if (cls.contains("vscode-high-contrast-light")) return "light";
  if (cls.contains("vscode-dark") || cls.contains("vscode-high-contrast")) return "dark";
  return "light";
}
preview.setTheme(currentThemeKind());
new MutationObserver(() => preview.setTheme(currentThemeKind())).observe(document.body, {
  attributes: true,
  attributeFilter: ["class"],
});

vscode.postMessage({ type: "ready" });
