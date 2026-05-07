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
      --math-font-family: "STIX Two Math", "Cambria Math", math;
      --math-caligraphic-font-family: "STIX Two Math", "Cambria Math", math;
      --code-font-family: "Noto Sans Mono", "Noto Sans Mono Fallback", monospace;
      --svg-text-size: 0.82em;
      /* Map ar5iv's color tokens onto the chrome theme so the preview
         surface matches the editor surface in every mode (paper / midnight
         / terminal). Custom properties cascade through the shadow boundary,
         so document-level chrome vars are visible here. Each mapping has
         the ar5iv default as a fallback. */
      --background-color:    var(--bg-elev, white);
      --text-color:          var(--ink, #292929);
      --border-color:        var(--ink, #292929);
      --border-light-color:  var(--rule, grey);
      --image-color:         black;
      --image-background-color: white;
      --link-text-color:     var(--ink, #212121);
      --email-link-color:    var(--accent, #026ecb);
      --note-mark-color:     var(--accent, #026ecb);
      --note-highlight-color: var(--accent-soft, #ffffd4);
      --info-text-color:     var(--ink-soft, #01719d);
      --warning-text-color:  var(--warn, #d09e05);
      --error-text-color:    var(--bad, #d8000c);
      --fatal-text-color:    var(--error-text-color);
      --index-ref-color:     var(--email-link-color);
      color: var(--text-color);
      background-color: var(--background-color);
    }
    /* ar5iv.css binds color/bg on \`body\`, but our shadow root has no body —
       only \`#preview-root-host\`. Without this rule \`color\` inherits the
       :host default (computed against light-mode \`--text-color\`) and never
       picks up the dark-theme value the \`[data-theme="dark"]\` rule sets on
       the inner host. Re-evaluating both on the inner host fixes contrast
       in dark mode. The \`min-height: 100%\` keeps the preview surface
       coloured all the way to the bottom of the pane (otherwise the chrome
       background pokes through under short documents). */
    #preview-root-host {
      color: var(--text-color);
      background-color: var(--background-color);
      min-height: 100%;
      box-sizing: border-box;
    }
    /* Override ar5iv.css's hard-coded dark palette (\`[data-theme="dark"]\`,
       specificity 0,0,1) with the chrome theme's own dark values via an
       ID-qualified selector (specificity 1,0,1). This makes the preview
       reuse midnight / terminal palettes instead of ar5iv's #0d1117 +
       #c9d1d9 pair. Note: \`--image-color\` / \`--image-background-color\`
       are intentionally kept at ar5iv's dark defaults because they drive
       per-image filter inversions independent of chrome theming. */
    #preview-root-host[data-theme="dark"] {
      --background-color:    var(--bg-elev, #0d1117);
      --text-color:          var(--ink, #c9d1d9);
      --border-color:        var(--ink-soft, #c9d1d9);
      --border-light-color:  var(--rule, #292929);
      --link-text-color:     var(--ink, #c9d1d9);
      --email-link-color:    var(--accent, #58a6ff);
      --note-mark-color:     var(--accent, #58a6ff);
      --note-highlight-color: var(--accent-soft, #3a2a00);
      --info-text-color:     var(--ink-soft, #58a6ff);
      --warning-text-color:  var(--warn, #d29922);
      --error-text-color:    var(--bad, #f85149);
    }
    /* Terminal chrome: replace the proportional body + heading
       typefaces with the chrome's own monospace stack so the
       preview reads in the same retro-CRT register as the rest of
       the page. Math glyphs keep STIX (mono fonts can't render math
       well) and so do code spans (already mono). */
    :host([data-chrome="terminal"]) {
      --headings-font-family: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      --text-font-family:     "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    }
    /* ar5iv.css gives framed-text variants only horizontal padding, so a
       span whose content is only whitespace collapses to a 0-height sliver
       once it's promoted to inline-block. Hold the box open with vertical
       padding + a min-height, and force a glyph for the truly-empty case. */
    .ltx_framed_rectangle,
    .ltx_framed_topbottom,
    .ltx_framed_top,
    .ltx_framed_bottom,
    .ltx_framed_underline,
    .ltx_framed_left,
    .ltx_framed_right,
    .ltx_framed_leftright {
      padding-top: 0.15rem;
      padding-bottom: 0.15rem;
      min-height: 1em;
      vertical-align: middle;
    }
    .ltx_framed_rectangle:empty::before,
    .ltx_framed_topbottom:empty::before,
    .ltx_framed_top:empty::before,
    .ltx_framed_bottom:empty::before,
    .ltx_framed_underline:empty::before,
    .ltx_framed_left:empty::before,
    .ltx_framed_right:empty::before,
    .ltx_framed_leftright:empty::before {
      content: "\\00a0";
    }
    .preview-empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 16rem;
      padding: 2rem;
      color: var(--text-color, #292929);
      opacity: 0.55;
      font-style: italic;
      font-family: var(--text-font-family, serif);
      font-size: 1rem;
      text-align: center;
    }
  </style>
`;
// ar5iv stylesheets, copied from `~/git/ar5iv-css/css` into our
// static dir. Self-hosted (rather than CDN-loaded) so the preview's
// font cascade stays independent of third-party uptime / TLS / CSP
// quirks. Math is currently `STIX Two Math`, loaded by ar5iv-fonts.css
// from Google Fonts via `@import`.
const AR5IV_CSS_LINKS = `
  <link rel="stylesheet" href="/static/css/ar5iv-fonts.css">
  <link rel="stylesheet" href="/static/css/ar5iv.css">
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

/** Mirror the chrome theme (`paper` / `midnight` / `terminal`) onto
 *  the shadow host so its CSS can layer chrome-specific styling
 *  inside the preview — the only one that uses this today is the
 *  terminal palette, which switches body + heading typography to
 *  monospace via a `:host([data-chrome="terminal"])` rule baked
 *  into `AR5IV_HOST_DEFAULTS`. Math typography stays put: STIX is
 *  the source of truth for math glyphs, and most monospace fonts
 *  ship without the math repertoire. */
export function setPreviewChromeTheme(chrome: string): void {
  const previewEl = document.getElementById("preview");
  if (!previewEl) return;
  previewEl.setAttribute("data-chrome", chrome);
}

/** Paint a centered placeholder string into the preview pane. Used
 *  when the project has no `.tex` file to render, so the user sees a
 *  clear next-step instruction instead of a blank pane or a stale
 *  prior render. */
export function showEmptyState(message: string): void {
  const host = ensurePreviewHost();
  const previewWrap = document.getElementById("preview")!;
  const log = document.getElementById("log")!;
  log.hidden = true;
  previewWrap.hidden = false;
  const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  host.innerHTML = `<div class="preview-empty-state">${safe}</div>`;
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
