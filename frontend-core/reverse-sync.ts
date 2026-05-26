// Reverse source-map sync: preview → source. The mirror of forward-sync. On a
// double-click inside the rendered HTML we find the tightest located construct
// under the pointer and report its source tag + start line/col plus a content
// fingerprint, so the caller can move the editor caret there (with
// `recoverSourcePosition`). Double-click (not single) so it never competes with
// reading, text selection, or following a link.

import { parseSourcepos } from "./sourcepos";

/** A source position picked from the preview by the user: the construct's
 *  integer `tag` (index into the conversion's `sources` table) plus its start
 *  line/column, the exact double-clicked `word`, and a `text` phrase of context
 *  used as a content fingerprint for recovery when the locator is imperfect. */
export interface SourceNavTarget {
  tag: number;
  line: number;
  col: number;
  word: string;
  text: string;
}

/** The selection's start offset within `leaf` and the selected word. A
 *  double-click selects the word under the pointer; the selection range lives
 *  inside the preview shadow tree, so this is the reliable way to read the
 *  click within shadowed content. `null` when there's no usable selection. */
function selectionInfo(leaf: HTMLElement): { offset: number; word: string } | null {
  const root = leaf.getRootNode() as ShadowRoot | Document;
  // ShadowRoot.getSelection() is the shadow-aware accessor (Blink/WebKit); fall
  // back to the document selection (Firefox keeps shadow selections there).
  const getSel = (root as unknown as { getSelection?: () => Selection | null }).getSelection;
  const sel = (getSel ? getSel.call(root) : null) ?? window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!leaf.contains(range.startContainer)) return null;
  const pre = document.createRange();
  pre.selectNodeContents(leaf);
  try {
    pre.setEnd(range.startContainer, range.startOffset);
  } catch {
    return null;
  }
  return { offset: pre.toString().length, word: sel.toString().replace(/\s+/g, " ").trim() };
}

/** The maximal non-whitespace run straddling `off` (fallback word when there's
 *  no selection). */
function wordAt(text: string, off: number): string {
  if (off < 0 || off > text.length) return "";
  let s = off;
  let e = off;
  while (s > 0 && !/\s/.test(text[s - 1]!)) s--;
  while (e < text.length && !/\s/.test(text[e]!)) e++;
  return text.slice(s, e).trim();
}

/** A whitespace-normalized phrase of `text` straddling char offset `off`: a
 *  ~`span`-char window each side, grown to whitespace boundaries, then
 *  collapsed. Specific enough to match unambiguously against the source. */
function phraseAround(text: string, off: number, span = 28): string {
  if (off < 0 || off > text.length) return "";
  let s = Math.max(0, off - span);
  let e = Math.min(text.length, off + span);
  while (s > 0 && !/\s/.test(text[s - 1]!)) s--;
  while (e < text.length && !/\s/.test(text[e]!)) e++;
  return text.slice(s, e).replace(/\s+/g, " ").trim();
}

/** Char offset of viewport point `(x, y)` within `leaf`'s rendered text, or
 *  `null` when unresolvable. Pierces the shadow tree (the standard caret-from-
 *  point APIs return shadow-internal nodes). */
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

/** Bind double-click → source navigation on the preview host, once. The
 *  listener sits on the persistent shadow host so it survives every re-render.
 *  `closest` descends to the tightest located element; within a single-line
 *  leaf we refine to the exact character by interpolating the click offset into
 *  `[fromCol..toCol]`. No-op outside any located construct. */
export function bindPreviewSourceNav(host: HTMLElement, onPick: (t: SourceNavTarget) => void): void {
  if ((host as { __ar5ivNavBound?: boolean }).__ar5ivNavBound) return;
  (host as { __ar5ivNavBound?: boolean }).__ar5ivNavBound = true;
  host.addEventListener("dblclick", (ev) => {
    const start = ev.target as Element | null;
    const leaf = start?.closest?.("[data-sourcepos]") as HTMLElement | null;
    if (!leaf) return;
    const sp = parseSourcepos(leaf.getAttribute("data-sourcepos") ?? "");
    if (!sp) return;
    const me = ev as MouseEvent;
    const leafText = leaf.textContent ?? "";
    const sel = selectionInfo(leaf);
    const off = sel?.offset ?? clickCharOffset(leaf, me.clientX, me.clientY);
    const word = sel?.word || (off != null ? wordAt(leafText, off) : "");
    const text = off != null ? phraseAround(leafText, off) : "";
    let col = sp.fromCol;
    if (sp.fromLine === sp.toLine && sp.toCol >= sp.fromCol && off != null) {
      col = sp.fromCol + Math.min(off, sp.toCol - sp.fromCol);
    }
    onPick({ tag: sp.fromTag, line: sp.fromLine, col, word, text });
  });
}
