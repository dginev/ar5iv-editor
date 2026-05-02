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

export type EditorTheme = "light" | "dark";

export interface EditorHandle {
  setSource(text: string): void;
  getSource(): string;
  onChange(cb: (tex: string) => void): void;
  setTheme(theme: EditorTheme): void;
}

export function createEditor(host: HTMLElement, initialTheme: EditorTheme): EditorHandle {
  let changeCb: ((tex: string) => void) | null = null;

  const themeCompartment = new Compartment();
  // One Dark for dark mode, GitHub Light for light mode. Both ship their own
  // syntax-highlight styles, so the latex grammar's tokens are coloured
  // identically across themes (just with the right palette).
  const themeOf = (t: EditorTheme): Extension =>
    t === "dark" ? oneDark : githubLight;

  const view = new EditorView({
    parent: host,
    state: EditorState.create({
      doc: "",
      extensions: [
        lineNumbers(),
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        indentOnInput(),
        latex(),
        // Default highlight style is registered as a fallback so the LaTeX
        // grammar's tokens always colour. When `oneDark` is active, its own
        // highlight style takes precedence.
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        themeCompartment.of(themeOf(initialTheme)),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        EditorView.lineWrapping,
        EditorView.updateListener.of((u) => {
          if (u.docChanged && changeCb) changeCb(u.state.doc.toString());
        }),
      ],
    }),
  });

  return {
    setSource(text) {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    getSource() {
      return view.state.doc.toString();
    },
    onChange(cb) {
      changeCb = cb;
    },
    setTheme(theme) {
      view.dispatch({ effects: themeCompartment.reconfigure(themeOf(theme)) });
    },
  };
}
