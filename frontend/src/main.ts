import "./styles.css";
import { createEditor, type EditorTheme } from "./editor.ts";
import { ConvertClient } from "./ws.ts";
import { renderResult, showLog, setPreviewTheme } from "./preview.ts";
import { EXAMPLES } from "./examples.ts";

const PREAMBLE_RE = /^([\s\S]*\\begin\{document\})([\s\S]*)\\end\{document\}([\s\S]*)$/;
const DEBOUNCE_MS = 100;
const THEME_KEY = "ar5iv-editor-theme";

type Theme = EditorTheme;

function getInitialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function statusEl(): HTMLElement {
  return document.getElementById("status")!;
}
function counterEl(): HTMLElement {
  return document.getElementById("counter")!;
}
function logEl(): HTMLElement {
  return document.getElementById("log")!;
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

function bootThemeToggle(applyTheme: (t: Theme) => void, initial: Theme): void {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  let current: Theme = initial;
  const render = () => {
    btn.textContent = current === "dark" ? "Light mode" : "Dark mode";
    btn.setAttribute("aria-label", `Switch to ${current === "dark" ? "light" : "dark"} mode`);
  };
  render();
  btn.addEventListener("click", () => {
    current = current === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_KEY, current);
    applyTheme(current);
    render();
  });
}

function main(): void {
  const initialTheme = getInitialTheme();
  document.documentElement.dataset.theme = initialTheme;
  setPreviewTheme(initialTheme);

  const editor = createEditor(
    document.getElementById("codemirror-host")!,
    initialTheme,
  );
  bootExamples(editor);

  bootThemeToggle((t) => {
    document.documentElement.dataset.theme = t;
    editor.setTheme(t);
    setPreviewTheme(t);
  }, initialTheme);

  const wsUrl =
    (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/convert";
  let latestSeenId = 0;
  const client = new ConvertClient(wsUrl, {
    onMessage: (resp) => {
      // Skip stale responses: the worker may reply "superseded" for requests
      // it dropped in favour of a newer one, and even successful but older
      // results would overwrite the freshest preview.
      if (resp.id < latestSeenId) return;
      if (resp.status === "superseded") return;
      latestSeenId = resp.id;
      counterEl().textContent = String(resp.id);
      if (resp.status_code === 3) {
        statusEl().textContent = "fatal";
        showLog(resp.log);
      } else {
        statusEl().textContent = resp.status || "ok";
        renderResult(resp.result);
        logEl().textContent = resp.log;
      }
    },
    onStatus: (s) => {
      statusEl().textContent = s;
    },
  });

  let nextId = 1;
  let timer: number | null = null;
  editor.onChange((tex) => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      const { preamble, body } = splitPreamble(tex);
      const id = nextId++;
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

  // Fire one initial conversion of the seed text.
  editor.setSource("Write your LaTeX snippet…\n\nor pick an example from the dropdown.");
}

main();
