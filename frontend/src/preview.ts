import { Idiomorph } from "idiomorph";
import {
  createPreview,
  type PreviewController,
  type SourceNavTarget,
} from "../../frontend-core/index";

export { recoverSourcePosition } from "../../frontend-core/index";
export type { SourceNavTarget };

// ---------------------------------------------------------------------------
// Web-editor adapter over the shared preview core (`frontend-core/`). The same
// core powers the VS Code webview; this file supplies only the editor-specific
// pieces: the chrome-theme color mapping, the self-hosted stylesheet URLs, and
// the idiomorph + KaTeX-fallback render. See `frontend-core/host.ts` for the
// structural CSS and the shadow-DOM caveats.
// ---------------------------------------------------------------------------

// Map ar5iv's color tokens onto the editor chrome tokens (paper / midnight /
// terminal), so the preview surface matches the editor surface in every mode.
// Chrome vars cascade through the shadow boundary; each has the ar5iv default
// as a fallback. `--ar5iv-sync-color` (consumed by the core's arrival-flash)
// is the chrome accent.
const HOST_TOKEN_CSS = `
  :host {
    --background-color:    var(--bg-elev, white);
    --text-color:          var(--ink, #292929);
    --border-color:        var(--ink, #292929);
    --border-light-color:  var(--rule, grey);
    --link-text-color:     var(--ink, #212121);
    --email-link-color:    var(--accent, #026ecb);
    --note-mark-color:     var(--accent, #026ecb);
    --note-highlight-color: var(--accent-soft, #ffffd4);
    --info-text-color:     var(--ink-soft, #01719d);
    --warning-text-color:  var(--warn, #d09e05);
    --error-text-color:    var(--bad, #d8000c);
    --ar5iv-sync-color:    var(--accent, #026ecb);
  }
  /* Terminal chrome: replace the proportional body + heading typefaces with the
     chrome's monospace stack so the preview reads in the same retro-CRT
     register. Math keeps STIX (mono fonts can't render math well). */
  :host([data-chrome="terminal"]) {
    --headings-font-family: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    --text-font-family:     "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  }
  /* Override ar5iv.css's hard-coded dark palette ([data-theme="dark"],
     specificity 0,0,1) with the chrome theme's own dark values via an
     ID-qualified selector (specificity 1,0,1) — reuse midnight / terminal
     palettes instead of ar5iv's #0d1117 + #c9d1d9 pair. --image-color /
     --image-background-color stay at ar5iv's dark defaults (per-image filter
     inversion, independent of chrome theming). */
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
`;

// ar5iv stylesheets, copied from `~/git/ar5iv-css/css` into our static dir.
// Self-hosted (rather than CDN-loaded) so the preview's font cascade stays
// independent of third-party uptime / TLS / CSP quirks.
const CSS_LINKS = `
  <link rel="stylesheet" href="/static/css/ar5iv-fonts.css">
  <link rel="stylesheet" href="/static/css/ar5iv.css">
`;

let controller: PreviewController | null = null;

function preview(): PreviewController {
  if (!controller) {
    controller = createPreview({
      container: document.getElementById("preview")!,
      hostTokenCss: HOST_TOKEN_CSS,
      cssLinks: CSS_LINKS,
      morph: (host, incoming) => {
        // Morph: preserves caret, scroll, focus where possible.
        Idiomorph.morph(host, incoming, { morphStyle: "innerHTML" });
        // Best-effort math fallback: if the browser lacks MathML support, lazy-
        // load KaTeX and re-render <math> nodes. Kept out of the shared core
        // (KaTeX is an editor-only dependency).
        if (!supportsMathML() && host.querySelector("math")) {
          void renderMathFallback(host);
        }
      },
    });
  }
  return controller;
}

export type PreviewTheme = "light" | "dark";

/**
 * ar5iv.css carries a built-in dark theme keyed off `[data-theme="dark"]`.
 * Setting it on the shadow root host (rather than on `:root`) keeps the editor
 * chrome free to follow its own palette.
 */
export function setPreviewTheme(theme: PreviewTheme): void {
  preview().setTheme(theme);
}

/** Mirror the chrome theme (`paper` / `midnight` / `terminal`) onto the shadow
 *  host so its CSS can layer chrome-specific styling inside the preview — today
 *  only the terminal palette uses it (monospace body/heading via the
 *  `:host([data-chrome="terminal"])` rule). Math typography stays put: STIX is
 *  the source of truth for math glyphs. */
export function setPreviewChromeTheme(chrome: string): void {
  const previewEl = document.getElementById("preview");
  if (!previewEl) return;
  previewEl.setAttribute("data-chrome", chrome);
}

/** Paint a centered placeholder string into the preview pane. Used when the
 *  project has no `.tex` file to render. */
export function showEmptyState(message: string): void {
  showPreviewPane();
  preview().showEmptyState(message);
}

export function renderResult(html: string): void {
  showPreviewPane();
  preview().renderResult(html);
}

export function showLog(text: string): void {
  const previewEl = document.getElementById("preview")!;
  const log = document.getElementById("log")!;
  log.textContent = text;
  previewEl.hidden = true;
  log.hidden = false;
}

/** Reveal the preview pane (hide the log pre). Both render paths route through
 *  here so a prior `showLog` is undone when fresh content lands. */
function showPreviewPane(): void {
  document.getElementById("log")!.hidden = true;
  document.getElementById("preview")!.hidden = false;
}

/** Forward source-map sync — scroll the preview to the edited source line and
 *  pulse the matching construct. Thin pass-through to the shared core. */
export function scrollPreviewToSource(
  line: number,
  col: number,
  token: string,
  activeFile: string,
  sources?: string[],
): void {
  preview().scrollToSource(line, col, token, activeFile, sources);
}

/** Reverse source-map sync — bind double-click → source navigation, once. */
export function bindPreviewSourceNav(onPick: (t: SourceNavTarget) => void): void {
  preview().bindSourceNav(onPick);
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
