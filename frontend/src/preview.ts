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
    /* Arrival highlight ("ping") on the preview element that maps to the
       source the user just edited (source-map sync). A soft accent ring via
       box-shadow — NOT a background fill: a fill's appearance depends on the
       element's box, so a full-width block wrapper (e.g. ltx_para inside a
       list item) turns into a heavy banner, whereas a ring traces any element
       (block or inline) consistently and shifts no layout. The accent token
       cascades through the shadow boundary, matching the active chrome theme.
       Endpoints use color-mix to fade the *alpha* (… N% → 0%, transparent), so
       the pulse fades out cleanly without a grey midpoint. */
    .ar5iv-sync-flash {
      animation: ar5iv-sync-flash-kf 3s ease-out;
      border-radius: 4px;
    }
    @keyframes ar5iv-sync-flash-kf {
      0% {
        box-shadow:
          0 0 0 2px color-mix(in srgb, var(--accent, #026ecb) 70%, transparent),
          0 0 12px 3px color-mix(in srgb, var(--accent, #026ecb) 45%, transparent);
      }
      100% {
        box-shadow:
          0 0 0 2px color-mix(in srgb, var(--accent, #026ecb) 0%, transparent),
          0 0 12px 3px color-mix(in srgb, var(--accent, #026ecb) 0%, transparent);
      }
    }
    /* Preferred arrival highlight: paint the matched element's TEXT (like a
       selection) via the CSS Custom Highlight API, so a full-width block (a
       list item / paragraph) highlights its glyphs rather than becoming a
       full-width banner; inline constructs stay tight. The alpha is animated
       on the preview root (WAAPI) for the 3s fade. Falls back to the
       ar5iv-sync-flash ring above when the API isn't available. */
    @property --ar5iv-sync-alpha {
      syntax: "<number>";
      inherits: true;
      initial-value: 0;
    }
    ::highlight(ar5iv-sync) {
      background-color: rgb(from var(--accent, #026ecb) r g b / var(--ar5iv-sync-alpha, 0));
      border-radius: 2px;
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

// ---------------------------------------------------------------------------
// Source-map sync: scroll the preview to the most recently edited source line.
//
// latexml-oxide (run with --source-map) stamps each preview element with a
// `data-sourcepos="tag:line:col[-tag:line:col]"` range (cmark-gfm-style; the
// integer `tag` indexes the conversion's `sources` table, which rides the WS
// envelope — never the HTML). We pick the element whose range best matches the
// edited line and scroll it into view. Line is authoritative; columns are
// best-effort upstream, so we match on lines only.
// ---------------------------------------------------------------------------

interface ParsedSourcepos {
  fromTag: number;
  fromLine: number;
  fromCol: number;
  toLine: number; // == fromLine for a point locator
  toCol: number; // == fromCol for a point locator
}

/** Parse a `data-sourcepos` value (`tag:line:col[-tag:line:col]`). Both
 *  endpoints' line + column are kept: the range is used for caret containment,
 *  and the from-endpoint feeds the reading-order anchor fallback. Null when
 *  malformed. */
function parseSourcepos(value: string): ParsedSourcepos | null {
  const dash = value.indexOf("-");
  const fromStr = dash >= 0 ? value.slice(0, dash) : value;
  const toStr = dash >= 0 ? value.slice(dash + 1) : fromStr;
  const fp = fromStr.split(":");
  const tp = toStr.split(":");
  if (fp.length < 3) return null;
  const fromTag = Number.parseInt(fp[0]!, 10);
  const fromLine = Number.parseInt(fp[1]!, 10);
  const fromCol = Number.parseInt(fp[2]!, 10);
  const toLine = tp.length >= 2 ? Number.parseInt(tp[1]!, 10) : fromLine;
  const toCol = tp.length >= 3 ? Number.parseInt(tp[2]!, 10) : fromCol;
  if (![fromTag, fromLine, fromCol, toLine, toCol].every(Number.isFinite)) return null;
  return { fromTag, fromLine, fromCol, toLine, toCol };
}

/** Final path component, lowercased — matches the basenames the server puts
 *  in `sources`. */
function baseName(p: string): string {
  return (p.split(/[/\\]/).pop() ?? p).toLowerCase();
}

/** Resolve the active file to its integer source tag via the conversion's
 *  `sources` table. Returns null to mean "match any tag" — the single-file
 *  case (one source, or no table), where every locator refers to that file
 *  and tag filtering would only risk a false miss. */
function resolveTag(sources: string[] | undefined, activeFile: string): number | null {
  if (!sources || sources.length <= 1) return null;
  const want = baseName(activeFile);
  const idx = sources.findIndex((s) => baseName(s) === want);
  return idx >= 0 ? idx : null;
}

/** Source-position ordering key for one stamped element; **lower wins**. We
 *  anchor to the construct that most recently *started* at or before the caret
 *  in source reading order `(line, col)` — the lexicographic generalisation of
 *  the line-only anchor, so it descends past a containing paragraph to the
 *  exact inline construct (e.g. a `\textbf` span) the caret sits in:
 *  - **anchor** (start ≤ caret) → `[0, -fromLine, -fromCol, span]`: the greatest
 *    start at or before the caret (latest line, then latest column), then the
 *    tightest range.
 *  - **after** (start > caret) → `[1, fromLine, fromCol, span]`: first construct
 *    beyond the caret — fallback only (the caret precedes all stamped content).
 *
 *  The **line is authoritative**; the column only breaks ties *within* the
 *  anchor line, and only ever narrows to a descendant — if a construct's start
 *  column is heuristically ahead of the caret (Bruce #101's eating-disorder),
 *  it drops out of the anchor set and we fall back to the line-level ancestor,
 *  never a wrong line. `span` (line extent, free from the parse) collapses
 *  nested nodes that share an exact start to the innermost — no DOM-depth walk.
 *  Containment, gap-recovery, and error-truncated tails all fall out of the one
 *  rule (the construct you edit *inside* has the greatest start ≤ caret). */
type RankKey = readonly [number, number, number, number];
function rankKey(fromLine: number, fromCol: number, span: number, line: number, col: number): RankKey {
  const atOrBefore = fromLine < line || (fromLine === line && fromCol <= col);
  return atOrBefore ? [0, -fromLine, -fromCol, span] : [1, fromLine, fromCol, span];
}
function keyLt(a: RankKey, b: RankKey): boolean {
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i]! < b[i]!;
  }
  return false;
}

/** Scroll the preview to the element that best corresponds to source `line` in
 *  `activeFile`, and pulse it.
 *
 *  **One pass, O(1) per node, no layout reads:** a single `querySelectorAll`
 *  then a linear scan keeping the best `rankKey` (integer compares only — no
 *  ancestor walks, no `getBoundingClientRect`). The scroll + flash are the only
 *  layout-touching work and are deferred to one animation frame, so selection
 *  never forces a reflow and the UI doesn't lag.
 *
 *  **Soft recovery:** the anchor rule never needs a node *at* line N, so gaps,
 *  big-container gaps, and error-truncated output (latexml's unhappy path,
 *  where the tail has no locators) all degrade to "nearest preceding construct"
 *  automatically. We also keep two running bests — one honouring the resolved
 *  file `tag`, one ignoring it — and prefer the tag-matched pick, falling back
 *  to the tag-agnostic one; that covers a mis-resolved tag (a
 *  `sources`/`active_file` mismatch or bug) so we still scroll *somewhere*
 *  sensible. No-op only when the preview carries no locators at all
 *  (source-map off / nothing rendered yet). */
export function scrollPreviewToSource(
  line: number,
  col: number,
  token: string,
  activeFile: string,
  sources?: string[],
): void {
  const host = ensurePreviewHost();
  const wantTag = resolveTag(sources, activeFile);

  let containing: { el: HTMLElement; lineSpan: number; colSpan: number } | null = null;
  let matched: { el: HTMLElement; key: RankKey } | null = null; // reading-order anchor, honours wantTag
  let any: { el: HTMLElement; key: RankKey } | null = null;     // reading-order anchor, ignores wantTag

  // Does the caret (line,col) fall inside [(fromLine,fromCol)..(toLine,toCol)]
  // in reading order?
  const within = (sp: ParsedSourcepos) =>
    (sp.fromLine < line || (sp.fromLine === line && sp.fromCol <= col)) &&
    (line < sp.toLine || (line === sp.toLine && col <= sp.toCol));

  for (const el of host.querySelectorAll<HTMLElement>("[data-sourcepos]")) {
    const raw = el.getAttribute("data-sourcepos");
    if (!raw) continue;
    const sp = parseSourcepos(raw);
    if (!sp) continue;
    const span = Math.abs(sp.toLine - sp.fromLine);
    const key = rankKey(sp.fromLine, sp.fromCol, span, line, col);
    if (any === null || keyLt(key, any.key)) any = { el, key };
    if (wantTag !== null && sp.fromTag !== wantTag) continue;
    if (matched === null || keyLt(key, matched.key)) matched = { el, key };
    // Tightest element whose RANGE actually contains the caret. Well-ranged
    // constructs (e.g. a section title `0:490:1-0:490:26`) win here. On an
    // identical range the LAST in document order wins — the deeper, more
    // specific element (the <h2> over its wrapping <section>, which currently
    // shares the heading's range because the section's body span isn't
    // recorded). `colSpan` only discriminates within a single line.
    if (within(sp)) {
      const lineSpan = sp.toLine - sp.fromLine;
      const colSpan = sp.toCol - sp.fromCol;
      if (
        containing === null ||
        lineSpan < containing.lineSpan ||
        (lineSpan === containing.lineSpan && colSpan <= containing.colSpan)
      ) {
        containing = { el, lineSpan, colSpan };
      }
    }
  }

  // Prefer the tightest element that actually CONTAINS the caret (well-ranged
  // constructs like titles/equations); else the reading-order anchor (for
  // collapsed-point inline constructs, which have no real range to contain it).
  let target = containing?.el ?? (matched ?? any)?.el ?? null;

  // Content-fingerprint refinement. Macro-argument text reports its construct's
  // END column for every char (the source columns are gone before digestion —
  // Bruce's wall), and that end can even be on a *different line* than the caret
  // (a `\textbf{…}` that wraps across source lines), so neither column nor line
  // can locate it. The edited *word* can. Scope to the caret's BLOCK — the
  // anchor's nearest paragraph/list-item/cell, of which the bold span is a DOM
  // child no matter how many source lines it spans — and pick the tightest
  // element in it whose rendered text contains the word. Block-scoping avoids
  // doc-wide false matches on a common word. Literal text only: a macro arg that
  // doesn't render verbatim (e.g. `\ref` → "Fig 3") won't match and the anchor
  // stands, so it never does worse.
  if (token.length >= 3 && target) {
    const block = target.closest(
      ".ltx_p,.ltx_para,.ltx_title,.ltx_caption,.ltx_item,li,dd,dt,td,th,figcaption,blockquote",
    ) as HTMLElement | null;
    if (block) {
      let best: { el: Element; len: number } | null = null;
      const consider = (el: Element) => {
        const txt = el.textContent ?? "";
        if (txt.includes(token) && (best === null || txt.length < best.len)) {
          best = { el, len: txt.length };
        }
      };
      consider(block);
      block.querySelectorAll("*").forEach(consider);
      if (best !== null) target = (best as { el: Element }).el as HTMLElement;
    }
  }

  if (!target) return;

  // Defer to the next frame so the just-morphed DOM has laid out, then scroll;
  // the highlight is started on *arrival* (see `flashOnArrival`) rather than at
  // departure, so a long smooth scroll doesn't burn the pulse before the eye
  // gets there. `scrollIntoView` crosses the shadow boundary to scroll the
  // preview pane; centring keeps the edited region comfortably in view.
  requestAnimationFrame(() => {
    target.scrollIntoView({ block: "center", behavior: "smooth" });
    flashOnArrival(target);
  });
}

/** Light the sync-flash highlight once `el` has stopped moving in the viewport
 *  — i.e. the smooth scroll has *arrived* — then remove it after the 3 s pulse.
 *  Per-frame position poll: fires when motion settles (saw movement, now
 *  still), or promptly when no scroll was needed (already in view), or at a
 *  hard safety cap so it can never hang. */
let syncAnim: Animation | null = null;

/** Flash the matched element's TEXT (text-width, like a selection) via the CSS
 *  Custom Highlight API — so a full-width block doesn't become a banner — with
 *  a 3s alpha fade. Falls back to the box-shadow ring class when the API (or a
 *  text range) isn't available. */
function flashElement(el: HTMLElement): void {
  const reg = (CSS as unknown as { highlights?: { set(k: string, v: unknown): void; delete(k: string): void } })
    .highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (r: Range) => unknown }).Highlight;
  if (reg && HighlightCtor && el.firstChild) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      reg.set("ar5iv-sync", new HighlightCtor(range));
      syncAnim?.cancel();
      syncAnim = ensurePreviewHost().animate(
        [{ "--ar5iv-sync-alpha": 0.4 } as Keyframe, { "--ar5iv-sync-alpha": 0 } as Keyframe],
        { duration: 3000, easing: "ease-out" },
      );
      syncAnim.onfinish = () => {
        try { reg.delete("ar5iv-sync"); } catch { /* registry already cleared */ }
      };
      return;
    } catch {
      /* fall through to the ring fallback */
    }
  }
  el.classList.add("ar5iv-sync-flash");
  window.setTimeout(() => el.classList.remove("ar5iv-sync-flash"), 3000);
}

function flashOnArrival(el: HTMLElement): void {
  const start = performance.now();
  let lastTop = el.getBoundingClientRect().top;
  let stableFrames = 0;
  let moved = false;
  const light = () => flashElement(el);
  const tick = () => {
    const top = el.getBoundingClientRect().top;
    const elapsed = performance.now() - start;
    if (Math.abs(top - lastTop) > 0.5) {
      moved = true;
      stableFrames = 0;
    } else {
      stableFrames++;
    }
    lastTop = top;
    if ((moved && stableFrames >= 2) || (!moved && elapsed > 150) || elapsed > 1500) {
      light();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------------------
// Reverse source-map sync: preview → source.
//
// The mirror of `scrollPreviewToSource`. On a double-click inside the rendered
// HTML we find the nearest located construct (the closest `[data-sourcepos]`
// ancestor of the click target) and report its source tag + start line/col so
// the caller can move the editor caret there. Double-click (not single) so it
// never competes with reading, text selection, or following a link.
// ---------------------------------------------------------------------------

/** A source position picked from the preview by the user: the construct's
 *  integer `tag` (index into the conversion's `sources` table) plus its start
 *  line/column. The caller resolves `tag` → file and reveals `line:col`. */
export interface SourceNavTarget {
  tag: number;
  line: number;
  col: number;
}

let sourceNavBound = false;

/** Char offset of the viewport point `(x, y)` within `leaf`'s rendered text, or
 *  `null` when it can't be resolved (point outside the leaf, or no caret API).
 *  Pierces the preview shadow tree — the standard caret-from-point APIs return
 *  shadow-internal nodes. Used to refine a reverse-nav click from the leaf's
 *  start to the exact character. */
function clickCharOffset(leaf: HTMLElement, x: number, y: number): number | null {
  let node: Node | null = null;
  let offset = 0;
  const d = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  if (typeof d.caretPositionFromPoint === "function") {
    const pos = d.caretPositionFromPoint(x, y); // standard (Firefox)
    if (pos) {
      node = pos.offsetNode;
      offset = pos.offset;
    }
  } else if (typeof d.caretRangeFromPoint === "function") {
    const r = d.caretRangeFromPoint(x, y); // WebKit / Blink
    if (r) {
      node = r.startContainer;
      offset = r.startOffset;
    }
  }
  if (!node || !leaf.contains(node)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(leaf);
  try {
    pre.setEnd(node, offset);
  } catch {
    return null;
  }
  return pre.toString().length;
}

/** Bind double-click → source navigation on the preview, once. The listener
 *  sits on the persistent shadow host (not the morphed content), so it survives
 *  every re-render without re-binding.
 *
 *  `closest` descends to the **tightest** located element under the pointer —
 *  with the precision locators that is a leaf: a math symbol (`<mi>`/`<mo>`), a
 *  table cell, a content-exact text run. Within a single-line leaf we then
 *  refine to the **exact character**: interpolate the click's char offset into
 *  the leaf's `[fromCol..toCol]` range (clamped), so a double-click lands on the
 *  source character under the pointer, not just the construct's start. Falls
 *  back to the leaf's start when the offset can't be resolved or the leaf spans
 *  multiple lines. The line stays authoritative (columns are best-effort under
 *  macro expansion — Bruce #101). No-op when the click is outside any located
 *  construct (source-map off, or whitespace between blocks). */
export function bindPreviewSourceNav(onPick: (t: SourceNavTarget) => void): void {
  if (sourceNavBound) return;
  const host = ensurePreviewHost();
  host.addEventListener("dblclick", (ev) => {
    const start = ev.target as Element | null;
    const leaf = start?.closest?.("[data-sourcepos]") as HTMLElement | null;
    if (!leaf) return;
    const sp = parseSourcepos(leaf.getAttribute("data-sourcepos") ?? "");
    if (!sp) return;
    let col = sp.fromCol;
    if (sp.fromLine === sp.toLine && sp.toCol >= sp.fromCol) {
      const me = ev as MouseEvent;
      const off = clickCharOffset(leaf, me.clientX, me.clientY);
      if (off != null) {
        col = sp.fromCol + Math.min(off, sp.toCol - sp.fromCol);
      }
    }
    onPick({ tag: sp.fromTag, line: sp.fromLine, col });
  });
  sourceNavBound = true;
}
