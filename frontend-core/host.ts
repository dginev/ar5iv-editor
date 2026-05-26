// Shared preview shadow-DOM host.
//
// The rendered ar5iv document lives inside a shadow root so ar5iv.css's global
// selectors (`body`, `img`, `:root` custom-property defaults) don't leak onto
// whatever chrome surrounds the preview (the web editor's panes, the VS Code
// webview toolbar). This module owns: building the shadow tree, the
// environment-independent structural CSS, theme switching, and the render /
// empty-state operations. Environment specifics (color-token mapping, the
// stylesheet `<link>` URLs, and the idiomorph implementation) are injected.

/** Structural, environment-independent CSS for the shadow root.
 *
 *  Shared tokens (font stacks, widths, image colors) and the structural rules
 *  (framed-box sizing, empty-state, source-sync arrival flash) live here so
 *  there is one copy. The per-environment `:host` color mapping and the
 *  `[data-theme="dark"]` palette override are supplied by `hostTokenCss`, which
 *  must define `--ar5iv-sync-color` and the ar5iv color tokens
 *  (`--background-color`, `--text-color`, `--email-link-color`, …).
 *
 *  Shadow-DOM caveat (why the tokens must be re-declared on `:host`): a `:root`
 *  selector inside a stylesheet that lives in a shadow tree matches the *outer*
 *  document root, not the shadow root — so ar5iv.css's `:root { … }` defaults
 *  are inert here. `:host` is the shadow tree's stand-in for that root. */
export const STRUCTURAL_CSS = `
  :host {
    --main-width: 52rem;
    --main-width-margin: 54rem;
    --headings-font-family: "Noto Sans", "Noto Sans Fallback", sans-serif;
    --text-font-family: "Noto Serif", "Noto Serif Fallback", serif;
    --math-font-family: "STIX Two Math", "Cambria Math", math;
    --math-caligraphic-font-family: "STIX Two Math", "Cambria Math", math;
    --code-font-family: "Noto Sans Mono", "Noto Sans Mono Fallback", monospace;
    --svg-text-size: 0.82em;
    --image-color: black;
    --image-background-color: white;
    --fatal-text-color: var(--error-text-color);
    --index-ref-color: var(--email-link-color);
    color: var(--text-color);
    background-color: var(--background-color);
  }
  /* ar5iv.css binds color/bg on \`body\`, but our shadow root has no body —
     only \`#preview-root-host\`. Re-evaluate both here so dark-theme contrast
     is correct, and keep the surface painted to the bottom of short docs. */
  #preview-root-host {
    color: var(--text-color);
    background-color: var(--background-color);
    min-height: 100%;
    box-sizing: border-box;
  }
  /* ar5iv.css gives framed-text variants only horizontal padding, so a span
     whose content is only whitespace collapses to a 0-height sliver once it's
     promoted to inline-block. Hold the box open and force a glyph when empty. */
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
  /* Arrival highlight ("ping") ring on the element mapped from the just-edited
     source. A box-shadow ring (not a fill) traces block or inline constructs
     consistently and shifts no layout. color-mix fades the alpha to 0 so the
     pulse fades cleanly without a grey midpoint. */
  .ar5iv-sync-flash {
    animation: ar5iv-sync-flash-kf 3s ease-out;
    border-radius: 4px;
  }
  @keyframes ar5iv-sync-flash-kf {
    0% {
      box-shadow:
        0 0 0 2px color-mix(in srgb, var(--ar5iv-sync-color, #026ecb) 70%, transparent),
        0 0 12px 3px color-mix(in srgb, var(--ar5iv-sync-color, #026ecb) 45%, transparent);
    }
    100% {
      box-shadow:
        0 0 0 2px color-mix(in srgb, var(--ar5iv-sync-color, #026ecb) 0%, transparent),
        0 0 12px 3px color-mix(in srgb, var(--ar5iv-sync-color, #026ecb) 0%, transparent);
    }
  }
  /* Preferred arrival highlight: paint the matched element's TEXT (like a
     selection) via the CSS Custom Highlight API, so a full-width block
     highlights its glyphs rather than becoming a banner. Alpha is animated on
     the host (WAAPI) for the fade; falls back to the ring above when the API
     isn't available. */
  @property --ar5iv-sync-alpha {
    syntax: "<number>";
    inherits: true;
    initial-value: 0;
  }
  ::highlight(ar5iv-sync) {
    background-color: rgb(from var(--ar5iv-sync-color, #026ecb) r g b / var(--ar5iv-sync-alpha, 0));
    border-radius: 2px;
  }
`;

export interface PreviewHostConfig {
  /** The light-DOM element the shadow root is attached to. */
  readonly container: HTMLElement;
  /** Environment color-token mapping: a `:host { … }` block defining the ar5iv
   *  color tokens + `--ar5iv-sync-color`, plus any `[data-theme="dark"]` /
   *  chrome-specific overrides. Concatenated before {@link STRUCTURAL_CSS}. */
  readonly hostTokenCss: string;
  /** `<link rel="stylesheet">` tags for the ar5iv font + document stylesheets,
   *  with environment-resolved URLs. */
  readonly cssLinks: string;
  /** Morph the freshly parsed `incoming` root into the live `host` (idiomorph),
   *  injected so the core carries no bundler-resolved dependency. */
  morph(host: HTMLElement, incoming: HTMLElement): void;
}

export class PreviewHost {
  private readonly parser = new DOMParser();

  constructor(private readonly config: PreviewHostConfig) {}

  /** Attach the shadow root on first use; return the inner `#preview-root-host`
   *  the ar5iv document renders into. */
  ensure(): HTMLElement {
    const { container } = this.config;
    let shadow = container.shadowRoot;
    if (!shadow) {
      shadow = container.attachShadow({ mode: "open" });
      shadow.innerHTML =
        `<style>${this.config.hostTokenCss}\n${STRUCTURAL_CSS}</style>` +
        this.config.cssLinks +
        `<div id="preview-root-host" class="ltx_page_main"></div>`;
    }
    return shadow.getElementById("preview-root-host") as HTMLElement;
  }

  /** ar5iv.css carries a built-in dark theme keyed off `[data-theme="dark"]`.
   *  Setting it on the inner host (not `:root`) keeps the surrounding chrome
   *  free to follow its own palette. */
  setTheme(theme: "light" | "dark"): void {
    const host = this.ensure();
    if (theme === "dark") host.setAttribute("data-theme", "dark");
    else host.removeAttribute("data-theme");
  }

  /** Render a converter HTML fragment, morphing in place to preserve scroll /
   *  selection / focus where possible. */
  renderResult(html: string): void {
    const host = this.ensure();
    const doc = this.parser.parseFromString(`<div id="preview-root">${html}</div>`, "text/html");
    const incoming = doc.getElementById("preview-root");
    if (!incoming) {
      host.innerHTML = html;
      return;
    }
    this.config.morph(host, incoming);
  }

  /** Paint a centered placeholder (no convertible source, idle slot, etc.). */
  showEmptyState(message: string): void {
    const host = this.ensure();
    const safe = message.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    host.innerHTML = `<div class="preview-empty-state">${safe}</div>`;
  }
}
