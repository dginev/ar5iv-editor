// Shared diagnostic helpers reused by every ar5iv client surface.
//
// Some converter diagnostics carry no usable source line — most importantly an
// undefined macro used inside a macro argument (e.g. `\section{… \foo …}`),
// where the token's source position is lost during digestion (Bruce #101). The
// engine reports these as `category: "undefined:\foo"` with source
// "Anonymous String" and no line. Rather than dropping such a diagnostic on
// line 1, we recover its location by finding the named token in the source.

export interface DiagnosticSpan {
  /** 1-based line. */
  readonly line: number;
  /** 1-based column. */
  readonly column: number;
  /** Length of the matched token, for a tight squiggle. */
  readonly length: number;
}

/** Best-effort source location for a diagnostic the engine could not anchor:
 *  pull the offending token out of the `category` (or message) and find its
 *  first occurrence in `source`. Returns null when no specific token can be
 *  extracted or found (caller should then fall back to a document-level
 *  placement). Pure — no DOM, shared across surfaces. */
export function locateDiagnosticToken(
  source: string,
  category: string,
  message: string,
): DiagnosticSpan | null {
  const needle = diagnosticNeedle(category, message);
  if (!needle) return null;
  const match = needle.regex.exec(source);
  if (!match) return null;
  // Offset → 1-based line/column.
  let line = 1;
  let column = 1;
  for (let i = 0; i < match.index; i++) {
    if (source[i] === "\n") {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column, length: match[0].length };
}

/** Extract a search pattern for the token a diagnostic refers to. Handles the
 *  common shapes: `undefined:\foo` (a control sequence) and `undefined:{env}`
 *  (an environment → its `\begin{env}`); falls back to a `T_CS[\foo]` mention
 *  in the message. Returns null for categories with no locatable token
 *  (`malformed:…`, `unexpected:&`, …). */
function diagnosticNeedle(category: string, message: string): { regex: RegExp } | null {
  const colon = category.indexOf(":");
  let token = colon >= 0 ? category.slice(colon + 1) : "";
  if (!token.startsWith("\\") && !token.startsWith("{")) {
    const fromMessage = /T_CS\[(\\[A-Za-z@]+)\]/.exec(message);
    if (fromMessage) token = fromMessage[1]!;
  }
  if (token.startsWith("\\")) {
    const name = token.slice(1);
    if (!/^[A-Za-z@]+$/.test(name)) return null;
    // The exact control sequence: `\name` not continued by another letter.
    return { regex: new RegExp(`\\\\${escapeRegExp(name)}(?![A-Za-z@])`) };
  }
  if (token.startsWith("{") && token.endsWith("}")) {
    const env = token.slice(1, -1);
    if (!/^[A-Za-z*]+$/.test(env)) return null;
    return { regex: new RegExp(`\\\\begin\\{${escapeRegExp(env)}\\}`) };
  }
  return null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
