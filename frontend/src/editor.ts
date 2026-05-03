import { EditorState, Compartment, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightSpecialChars,
  drawSelection,
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
  setDiagnostics,
  lintGutter,
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

export function createEditor(host: HTMLElement, initialTheme: EditorTheme): EditorHandle {
  const buffers = new Map<string, Buffer>();
  let active: string | null = null;
  let onChangeCb: ((path: string, source: string) => void) | null = null;
  let currentTheme: EditorTheme = initialTheme;

  const themeCompartment = new Compartment();
  const themeOf = (t: EditorTheme): Extension =>
    t === "dark" ? oneDark : githubLight;

  const buildExtensions = (theme: EditorTheme): Extension[] => [
    lineNumbers(),
    lintGutter(),
    highlightSpecialChars(),
    history(),
    drawSelection(),
    highlightActiveLine(),
    bracketMatching(),
    indentOnInput(),
    latex(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    themeCompartment.of(themeOf(theme)),
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
          to = tline.from + Math.max(0, (d.toCol ?? line.length) - 1);
        } else if (d.fromCol !== undefined) {
          to = Math.min(line.to, from + 1);
        } else {
          // No column info — mark the whole line.
          from = line.from;
          to = line.to;
        }
        from = Math.max(line.from, Math.min(from, doc.length));
        to = Math.max(from, Math.min(to, doc.length));
        cm.push({
          from,
          to,
          severity: d.severity,
          message: d.message,
        });
      }
      view.dispatch(setDiagnostics(view.state, cm));
    },
  };
}
