// Convert-request shaping shared by every ar5iv client surface: how to split a
// document's preamble, detect a full document vs a fragment, and pick the
// preload set. Pure string logic with no DOM or backend dependency, used by the
// web editor (`/editor`) and the VS Code extension's conversion request builder.

// ar5iv.sty must come FIRST: it calls `pass_options("latexml","sty",…,
// tokenlimit=249999999)` before requiring latexml.sty. Once anything else in
// the preload list triggers a latexml.sty load (article.cls and the amsmath
// family do), the higher token limit can no longer be passed in.
export const PRELOAD_AR5IV_ONLY: readonly string[] = ["ar5iv.sty"];

// For fragment input (no \documentclass) we also preload the article class +
// the common math/color/link packages so a snippet renders without the user
// declaring them. A full document loads what it needs itself.
export const PRELOAD_FRAGMENT: readonly string[] = [
  "ar5iv.sty",
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
];

/** Mirrors the server's `contains_documentclass` (convert.rs): true iff the
 *  source contains `\documentclass` outside a comment. A full document loads
 *  its own packages, so we only need ar5iv.sty in front; a fragment needs the
 *  article-class chain too. */
export function hasDocumentclass(tex: string): boolean {
  for (const line of tex.split("\n")) {
    const trimmed = line.replace(/^\s+/, "");
    if (trimmed.startsWith("%")) continue;
    const idx = trimmed.indexOf("\\documentclass");
    if (idx >= 0 && !hasUnescapedPercent(trimmed.slice(0, idx))) return true;
  }
  return false;
}

/** The preload set for `tex`: ar5iv-only for full documents, the fragment chain
 *  otherwise. */
export function preloadFor(tex: string): readonly string[] {
  return hasDocumentclass(tex) ? PRELOAD_AR5IV_ONLY : PRELOAD_FRAGMENT;
}

/** Split a document into its preamble (everything up to and including
 *  `\begin{document}`, prefixed `literal:` for the convert wire) and body.
 *  Returns `{ preamble: null, body: tex }` when there is no document
 *  environment (a bare fragment). */
export function splitPreamble(tex: string): { preamble: string | null; body: string } {
  const beginMarker = "\\begin{document}";
  const endMarker = "\\end{document}";
  const begin = tex.indexOf(beginMarker);
  const end = tex.lastIndexOf(endMarker);
  if (begin < 0 || end < begin) return { preamble: null, body: tex };
  const bodyStart = begin + beginMarker.length;
  return {
    preamble: `literal:${tex.slice(0, bodyStart)}`,
    body: tex.slice(bodyStart, end),
  };
}

function hasUnescapedPercent(value: string): boolean {
  let escaped = false;
  for (const ch of value) {
    if (ch === "%" && !escaped) return true;
    escaped = ch === "\\" && !escaped;
  }
  return false;
}
