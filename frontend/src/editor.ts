import {
  EditorState,
  EditorSelection,
  StateField,
  StateEffect,
  Compartment,
  Prec,
  type Extension,
} from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightSpecialChars,
  drawSelection,
  Decoration,
  type DecorationSet,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
} from "@codemirror/commands";
import {
  bracketMatching,
  indentOnInput,
  syntaxHighlighting,
  defaultHighlightStyle,
} from "@codemirror/language";
import { oneDark } from "@codemirror/theme-one-dark";
import { githubLight } from "@uiw/codemirror-theme-github";
import { latex } from "codemirror-lang-latex";
import {
  lintGutter,
  linter,
  setDiagnostics as setLintDiagnostics,
  type Diagnostic as CmDiagnostic,
} from "@codemirror/lint";

export type EditorTheme = "light" | "dark";

/** Line-anchored diagnostic from the convert engine, in the shape
 *  the editor wants — already filtered to the active buffer's
 *  source by the caller. */
export interface LineDiagnostic {
  severity: "info" | "warning" | "error";
  message:  string;
  /** 1-indexed line number in the buffer. */
  fromLine: number;
  fromCol?: number;
  toLine?:  number;
  toCol?:   number;
}

export interface EditorHandle {
  /** Open or switch to a buffer keyed by `path`. If the buffer
   *  doesn't exist yet, it's created with `source` as the initial
   *  content. The buffer's selection / undo history / scroll position
   *  are preserved across switches. */
  openBuffer(path: string, source: string): void;
  /** Drop a buffer's state. If it was active, the next `openBuffer`
   *  call decides what to show. */
  closeBuffer(path: string): void;
  /** Drop every buffer. Used on session-swap so the editor doesn't
   *  reuse a buffer keyed by the same path under a different
   *  session (whose disk contents differ). */
  closeAllBuffers(): void;
  /** The path of the currently-displayed buffer, or `null` if none. */
  getActivePath(): string | null;
  /** Replace the contents of the active buffer (e.g., on
   *  example-load). No-op if no buffer is active. */
  setSource(text: string): void;
  /** Current contents of the active buffer (empty string if none). */
  getSource(): string;
  /** Caret context for the preview sync: 1-based line + column of the main
   *  selection head, plus the word token under the caret. The token is the
   *  content-fingerprint used to land on the exact inline construct when its
   *  source columns are unreliable (macro-argument text). Empty when the caret
   *  is not in a word. */
  getCursorPos(): { line: number; col: number; token: string };
  /** Move the caret to (1-based) `line`:`col` in the active buffer, scroll
   *  that line to the centre of the viewport, and briefly pulse it. Drives the
   *  reverse source-map sync (double-click a construct in the preview → jump to
   *  its source). The caller switches to the correct buffer first; this acts on
   *  whatever buffer is active. Out-of-range line/col are clamped to the doc. */
  revealPosition(line: number, col: number): void;
  /** Subscribe to live edits on the active buffer. The callback
   *  receives the path and the new source on every doc change. */
  onChange(cb: (path: string, source: string) => void): void;
  /** Switch the editor (and every cached buffer) to the given theme. */
  setTheme(theme: EditorTheme): void;
  /** Replace the lint markers on the active buffer. Pass `[]` to
   *  clear. The caller is responsible for filtering server-side
   *  diagnostics down to those that target the active file. */
  setDiagnostics(diags: LineDiagnostic[]): void;
}

/** One per open file; held in `BufferStore` and swapped through the
 *  single shared `EditorView`. CodeMirror 6's `EditorState` already
 *  carries selection, doc, and undo history; we add `scroll` so the
 *  scroll position is preserved on switch (it lives on the DOM, not
 *  the state). */
interface Buffer {
  state:  EditorState;
  scroll: number;
}

// --- Reverse source-map sync: transient line flash ------------------------
// When the user double-clicks a located construct in the preview, the editor
// jumps to the matching source line and pulses it so the eye can find the
// caret's new home. A one-line decoration toggled by a state effect (set on
// arrival, cleared after the pulse); the colour fade is a CSS keyframe so it
// costs nothing after the dispatch. `--accent` cascades from the chrome theme,
// matching the preview's own arrival highlight.
const setNavFlash = StateEffect.define<number | null>();
const navFlashDeco = Decoration.line({ class: "cm-nav-flash" });
const navFlashField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setNavFlash)) {
        deco =
          e.value === null
            ? Decoration.none
            : Decoration.set([navFlashDeco.range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
const navFlashTheme = EditorView.theme({
  ".cm-nav-flash": { animation: "cm-nav-flash 1.5s ease-out" },
  "@keyframes cm-nav-flash": {
    from: { backgroundColor: "color-mix(in srgb, var(--accent, #026ecb) 50%, transparent)" },
    to: { backgroundColor: "color-mix(in srgb, var(--accent, #026ecb) 0%, transparent)" },
  },
});

export function createEditor(host: HTMLElement, initialTheme: EditorTheme): EditorHandle {
  const buffers = new Map<string, Buffer>();
  let active: string | null = null;
  let onChangeCb: ((path: string, source: string) => void) | null = null;
  let currentTheme: EditorTheme = initialTheme;

  const themeCompartment = new Compartment();
  const themeOf = (t: EditorTheme): Extension =>
    t === "dark" ? oneDark : githubLight;

  // Selection visibility is set via `EditorView.theme(...)` rather
  // than a global stylesheet override: the bundled themes
  // (`oneDark`, `githubLight`) ship low-contrast selection colors
  // (`#3e4451` over `#282c34` in oneDark, `#bbdfff` over white in
  // githubLight) that read as invisible against our chrome surfaces.
  // The values are accent-tinted via the chrome's `--accent` token
  // so each chrome theme (paper / midnight / terminal) gets a hue
  // that matches its palette.
  //
  // `!important` is required because both bundled themes inject
  // their selection rules into the same head as ours; depending on
  // mount order their `<style>` tag can end up later in the
  // document and win the cascade at equal specificity. `!important`
  // inside an `EditorView.theme(...)` spec is part of the CM theme
  // API (it's how CM6 itself overrides browser-default
  // `::selection` rules) so we stay within the framework rather
  // than reaching outside it via global CSS.
  const selectionTheme = EditorView.theme({
    // Lift the selection layer above `.cm-content` (z auto) so the
    // highlight paints over the bundled active-line background.
    // Default CM6 puts the selection layer at z-index -2, which
    // means an opaque `.cm-activeLine` backdrop occludes it. Cursor
    // layer sits at z 100, so this still keeps the caret on top.
    ".cm-selectionLayer": { zIndex: "1 !important" },
    // Both focused AND unfocused paths set explicitly. The unfocused
    // selector goes through `.cm-scroller > .cm-selectionLayer` so
    // it has *more* classes than the bundled `.ͼ15 .cm-selectionLayer
    // .cm-selectionBackground` rule it's competing with — without
    // that, when the editor loses focus (e.g. the user clicks the
    // chrome theme button), `.cm-focused` drops off `.cm-editor` and
    // the focused selector stops matching, leaving the bundled
    // light-blue selection rule to win on specificity.
    "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      { backgroundColor: "color-mix(in srgb, var(--accent) 38%, transparent) !important" },
    "& > .cm-scroller > .cm-selectionLayer .cm-selectionBackground":
      { backgroundColor: "color-mix(in srgb, var(--accent) 38%, transparent) !important" },
    ".cm-selectionMatch":
      { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent) !important" },
  });

  // Timer that clears the reverse-sync line flash after its pulse; tracked so
  // a rapid second jump cancels the first instead of clearing mid-pulse.
  let navFlashTimer: number | undefined;

  const buildExtensions = (theme: EditorTheme): Extension[] => [
    lineNumbers(),
    navFlashField,
    navFlashTheme,
    // Lint plumbing — diagnostics are pushed from outside (the
    // convert engine) via `setDiagnostics` below. Passing `null`
    // as the linter source pre-installs the lint state field at
    // construction time. Without this, the first `setDiagnostics`
    // dispatch only `appendConfig`s the field, and same-transaction
    // effects aren't visible to a freshly-created field — so the
    // first batch of markers silently disappears.
    linter(null),
    lintGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    bracketMatching(),
    indentOnInput(),
    // `enableLinting: false` — codemirror-lang-latex ships its own
    // syntactic linter that runs on a 750ms timer and dispatches a
    // canonical `setDiagnosticsEffect`, which silently clobbers any
    // diagnostics we push from outside (i.e. from the convert
    // engine). The engine is authoritative for our use case, so we
    // turn the bundled linter off.
    latex({ enableLinting: false }),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    themeCompartment.of(themeOf(theme)),
    // `Prec.highest` ensures our selection theme's `<style>` tag is
    // injected after the bundled color theme's modules, winning the
    // cascade at equal specificity. Without it, `@uiw/codemirror-
    // theme-github`'s lazy modules mount last and override us.
    Prec.highest(selectionTheme),
    keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.lineWrapping,
    EditorView.updateListener.of((u) => {
      if (u.docChanged && onChangeCb && active !== null) {
        onChangeCb(active, u.state.doc.toString());
      }
    }),
  ];

  const view = new EditorView({
    parent: host,
    state: EditorState.create({ doc: "", extensions: buildExtensions(initialTheme) }),
  });

  /** Capture the active buffer's current state + scroll so a subsequent
   *  `view.setState` for another buffer doesn't lose them. */
  function persistActive(): void {
    if (active && buffers.has(active)) {
      const buf = buffers.get(active)!;
      buf.state = view.state;
      buf.scroll = view.scrollDOM.scrollTop;
    }
  }

  return {
    openBuffer(path, source) {
      if (active === path) return;
      persistActive();
      let buf = buffers.get(path);
      if (!buf) {
        const state = EditorState.create({
          doc:        source,
          extensions: buildExtensions(currentTheme),
        });
        buf = { state, scroll: 0 };
        buffers.set(path, buf);
      } else {
        // Ensure the buffer's compartment reflects the current theme,
        // since `setTheme` only dispatches against the live view-state.
        // This is a pure transform on the EditorState (no view side
        // effects) so it's safe to do outside an active view.
        buf.state = buf.state.update({
          effects: themeCompartment.reconfigure(themeOf(currentTheme)),
        }).state;
      }
      view.setState(buf.state);
      // Restore scroll on the next paint — `setState` resets the DOM
      // scrollTop and we need to wait for layout before re-applying.
      requestAnimationFrame(() => {
        view.scrollDOM.scrollTop = buf!.scroll;
      });
      active = path;
    },
    closeBuffer(path) {
      buffers.delete(path);
      if (active === path) active = null;
    },
    closeAllBuffers() {
      buffers.clear();
      active = null;
    },
    getActivePath() {
      return active;
    },
    setSource(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    getSource() {
      return view.state.doc.toString();
    },
    getCursorPos() {
      const head = view.state.selection.main.head;
      const line = view.state.doc.lineAt(head);
      const offset = head - line.from; // 0-based index within the line
      const text = line.text;
      const isWord = (ch: string | undefined) => !!ch && /[A-Za-z0-9]/.test(ch);
      let s = offset;
      let e = offset;
      while (s > 0 && isWord(text[s - 1])) s--;
      while (e < text.length && isWord(text[e])) e++;
      return { line: line.number, col: offset + 1, token: text.slice(s, e) };
    },
    revealPosition(line, col) {
      // Defer one frame: when the caller just switched buffers, `openBuffer`
      // has queued a scroll-restore rAF; running after it lets our centring
      // scroll win instead of being clobbered by the restored scrollTop.
      requestAnimationFrame(() => {
        const doc = view.state.doc;
        const lineNo = Math.max(1, Math.min(line, doc.lines));
        const ln = doc.line(lineNo);
        // Columns are best-effort upstream (macro-argument text reports its
        // construct's end column — Bruce #101), so clamp into the line; the
        // line is authoritative and the whole-line flash hides any column slip.
        const pos = ln.from + Math.max(0, Math.min((col || 1) - 1, ln.length));
        view.dispatch({
          selection: EditorSelection.cursor(pos),
          effects: [
            EditorView.scrollIntoView(pos, { y: "center" }),
            setNavFlash.of(ln.from),
          ],
        });
        view.focus();
        if (navFlashTimer !== undefined) window.clearTimeout(navFlashTimer);
        navFlashTimer = window.setTimeout(() => {
          view.dispatch({ effects: setNavFlash.of(null) });
        }, 1500);
      });
    },
    onChange(cb) {
      onChangeCb = cb;
    },
    setTheme(theme) {
      currentTheme = theme;
      // Reconfigure the active buffer immediately. Other buffers
      // pick up the new theme on `openBuffer` (see the reconfigure
      // step there).
      view.dispatch({
        effects: themeCompartment.reconfigure(themeOf(theme)),
      });
    },
    setDiagnostics(diags) {
      // Build the CmDiagnostic[] payload from line/col anchors,
      // then dispatch the lint extension's `setDiagnostics`
      // transaction spec onto the view. That installs the lint
      // state field on first use and updates the active buffer's
      // markers on subsequent calls.
      const cm: CmDiagnostic[] = [];
      const doc = view.state.doc;
      for (const d of diags) {
        // Clamp the 1-based line to the buffer's current line count.
        // A stale convert response can name a line past the end of
        // the buffer if the user has just deleted lines; render at
        // the last line in that case.
        const lineNo = Math.max(1, Math.min(d.fromLine, doc.lines));
        const line = doc.line(lineNo);
        let from = line.from + Math.max(0, (d.fromCol ?? 1) - 1);
        let to = from;
        if (d.toLine !== undefined) {
          const tln = Math.max(1, Math.min(d.toLine, doc.lines));
          const tline = doc.line(tln);
          // Use the toCol if provided; otherwise fall back to end-
          // of-line. Zero out the off-by-one and clamp.
          const toColIdx =
            d.toCol !== undefined ? Math.max(0, d.toCol - 1) : tline.length;
          to = tline.from + toColIdx;
        } else if (d.fromCol !== undefined) {
          // Single-position locator: highlight one character.
          to = Math.min(line.to, from + 1);
        } else {
          // No column info — mark the whole line.
          from = line.from;
          to = line.to;
        }
        from = Math.max(line.from, Math.min(from, doc.length));
        to = Math.max(from, Math.min(to, doc.length));
        // Lint markers with a zero-width range render no
        // visible underline (CodeMirror skips them). Many engine
        // diagnostics produce identical from/to columns (e.g. an
        // undefined-macro error pointing at one cursor position);
        // expand to the rest of the line so the user sees a
        // visible marker.
        if (to <= from) {
          to = line.to;
          if (to <= from) {
            // Empty line — push to start of next line.
            to = Math.min(doc.length, from + 1);
          }
        }
        cm.push({
          from,
          to,
          severity: d.severity,
          message: d.message,
        });
      }
      view.dispatch(setLintDiagnostics(view.state, cm));
    },
  };
}
