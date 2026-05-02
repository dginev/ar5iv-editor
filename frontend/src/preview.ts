import { Idiomorph } from "idiomorph";

const PARSER = new DOMParser();

// ar5iv stylesheets, loaded once into the preview's shadow root so their
// global selectors (`body`, `img`, `:root` custom-property defaults) don't
// leak into the editor chrome.
//
// Shadow-DOM caveat: `:root` selectors inside a stylesheet that lives in a
// shadow tree match the *outer* document root, not the shadow root — which
// means ar5iv.css's `:root { --border-color: ...; --text-color: ...; ... }`
// block is silently inert inside our shadow. We re-declare the same defaults
// under `:host` so the cascade has values to inherit from. ar5iv's existing
// `[data-theme="dark"]` rule (set on the inner `#preview-root-host` div by
// `setPreviewTheme`) still overrides per-theme.
const AR5IV_HOST_DEFAULTS = `
  <style>
    :host {
      --main-width: 52rem;
      --main-width-margin: 54rem;
      --headings-font-family: "Noto Sans", "Noto Sans Fallback", sans-serif;
      --text-font-family: "Noto Serif", "Noto Serif Fallback", serif;
      --math-font-family: "latin modern math", "Cambria Math", math;
      --math-caligraphic-font-family: "latin modern math", "Cambria Math", math;
      --code-font-family: "Noto Sans Mono", "Noto Sans Mono Fallback", monospace;
      --svg-text-size: 0.82em;
      --background-color: white;
      --text-color: #292929;
      --border-color: #292929;
      --border-light-color: grey;
      --image-color: black;
      --image-background-color: white;
      --link-text-color: #212121;
      --email-link-color: #026ecb;
      --note-mark-color: #026ecb;
      --note-highlight-color: #ffffd4;
      --info-text-color: #01719d;
      --warning-text-color: #d09e05;
      --error-text-color: #d8000c;
      --fatal-text-color: var(--error-text-color);
      --index-ref-color: var(--email-link-color);
      color: var(--text-color);
      background-color: var(--background-color);
    }
  </style>
`;
const AR5IV_CSS_LINKS = `
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/dginev/ar5iv-css@0.8.5/css/ar5iv-fonts.css">
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/dginev/ar5iv-css@0.8.5/css/ar5iv.css">
`;

function ensurePreviewHost(): HTMLElement {
  const preview = document.getElementById("preview")!;
  let shadow = preview.shadowRoot;
  if (!shadow) {
    shadow = preview.attachShadow({ mode: "open" });
    shadow.innerHTML = `${AR5IV_HOST_DEFAULTS}${AR5IV_CSS_LINKS}<div id="preview-root-host" class="ltx_page_main"></div>`;
  }
  return shadow.getElementById("preview-root-host") as HTMLElement;
}

export type PreviewTheme = "light" | "dark";

/**
 * ar5iv.css carries a built-in dark theme keyed off `[data-theme="dark"]`.
 * Setting it on the shadow root host (rather than on `:root`) keeps the
 * editor chrome free to follow its own palette.
 */
export function setPreviewTheme(theme: PreviewTheme): void {
  const host = ensurePreviewHost();
  if (theme === "dark") {
    host.setAttribute("data-theme", "dark");
  } else {
    host.removeAttribute("data-theme");
  }
}

export function renderResult(html: string): void {
  const host = ensurePreviewHost();
  const previewWrap = document.getElementById("preview")!;
  const log = document.getElementById("log")!;
  log.hidden = true;
  previewWrap.hidden = false;

  // Parse the fragment safely: wrap in a body so the parser is happy.
  const doc = PARSER.parseFromString(`<div id="preview-root">${html}</div>`, "text/html");
  const incoming = doc.getElementById("preview-root");
  if (!incoming) {
    host.innerHTML = html;
    return;
  }
  // Morph: preserves caret, scroll, focus where possible.
  Idiomorph.morph(host, incoming, { morphStyle: "innerHTML" });

  // Best-effort math fallback: if browser MathML support is missing, lazy-load
  // KaTeX and re-render <math> nodes. Done here rather than at module top so
  // the bundle stays small for browsers that already render MathML natively.
  if (!supportsMathML() && host.querySelector("math")) {
    void renderMathFallback(host);
  }
}

export function showLog(text: string): void {
  const preview = document.getElementById("preview")!;
  const log = document.getElementById("log")!;
  log.textContent = text;
  preview.hidden = true;
  log.hidden = false;
}

function supportsMathML(): boolean {
  // Heuristic: render a MathML node off-screen and inspect its layout.
  const probe = document.createElementNS("http://www.w3.org/1998/Math/MathML", "math");
  probe.innerHTML = "<mspace height=\"23px\" width=\"77px\"/>";
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  document.body.appendChild(probe);
  const ok = probe.getBoundingClientRect().height > 5;
  probe.remove();
  return ok;
}

async function renderMathFallback(root: HTMLElement): Promise<void> {
  const [{ default: katex }] = await Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]);
  for (const node of Array.from(root.querySelectorAll("math"))) {
    const tex = node.querySelector("annotation[encoding=\"application/x-tex\"]")?.textContent;
    if (!tex) continue;
    const span = document.createElement("span");
    try {
      katex.render(tex, span, { throwOnError: false, output: "html" });
      node.replaceWith(span);
    } catch {
      // fall through; leave the original <math> in place
    }
  }
}
