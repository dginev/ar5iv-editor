import "./styles.css";
import { createEditor, type EditorTheme } from "./editor.ts";
import { ConvertClient, type ConvertResponse } from "./ws.ts";
import { renderResult, showLog, setPreviewTheme } from "./preview.ts";
import { EXAMPLES } from "./examples.ts";

const PREAMBLE_RE = /^([\s\S]*\\begin\{document\})([\s\S]*)\\end\{document\}([\s\S]*)$/;
const DEBOUNCE_MS = 300;

type ChromeTheme = "paper" | "midnight" | "terminal";

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

  // Mark the slowest contributing stage (excluding `total`, which is the
  // sum and would always win) so the user's eye lands on it.
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

function bootExamples(view: { setSource: (s: string) => void }): void {
  const select = document.getElementById("example-select") as HTMLSelectElement;
  for (const name of Object.keys(EXAMPLES)) {
    const opt = document.createElement("option");
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => {
    const v = select.value;
    if (!v) return;
    view.setSource(EXAMPLES[v]!);
  });
}

function main(): void {
  const initialEditorTheme = chromeToEditor(readChromeTheme());
  setPreviewTheme(initialEditorTheme);

  const host = document.getElementById("codemirror-host");
  if (!host) return;

  const editor = createEditor(host, initialEditorTheme);
  bootExamples(editor);

  // The chrome theme is owned by the inline script in base.html; listen for
  // its change event and propagate to the editor and preview only.
  window.addEventListener("ar5iv:themechange", (ev) => {
    const detail = (ev as CustomEvent<{ theme: string }>).detail;
    const e = chromeToEditor(detail?.theme);
    editor.setTheme(e);
    setPreviewTheme(e);
  });

  const wsUrl =
    (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/convert";
  let latestSeenId = 0;
  const sentAt = new Map<number, number>();
  const client = new ConvertClient(wsUrl, {
    onMessage: (resp) => {
      // Skip stale responses: the worker may reply "superseded" for requests
      // it dropped in favour of a newer one, and even successful but older
      // results would overwrite the freshest preview.
      if (resp.id < latestSeenId) {
        sentAt.delete(resp.id);
        return;
      }
      if (resp.status === "superseded") {
        sentAt.delete(resp.id);
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
    },
    onStatus: (s) => {
      statusEl().textContent = s;
    },
  });

  let nextId = 1;
  let timer: number | null = null;
  editor.onChange((tex) => {
    const cc = charCountEl();
    if (cc) cc.textContent = `${tex.length.toLocaleString()} chars`;
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const { preamble, body } = splitPreamble(tex);
      const id = nextId++;
      sentAt.set(id, performance.now());
      client.send({
        id,
        tex: body,
        preamble: preamble ?? undefined,
        profile: "fragment",
        format: "html5",
        preload: [
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
        ],
      });
      statusEl().textContent = "converting…";
    }, DEBOUNCE_MS);
  });

  editor.setSource("Write your LaTeX snippet…\n\nor pick an example from the dropdown.");
}

main();
