// Shared source-map locator parsing.
//
// latexml-oxide (run with --source-map) stamps each preview element with a
// `data-sourcepos="tag:line:col[-tag:line:col]"` range (cmark-gfm style; the
// integer `tag` indexes the conversion's `sources` table, which rides the
// conversion envelope — never the HTML). This module is the single parser used
// by both source-sync directions, in every preview host.

export interface ParsedSourcepos {
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
export function parseSourcepos(value: string): ParsedSourcepos | null {
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

/** Final path component, lowercased — matches the basenames the server puts in
 *  the `sources` table. */
export function baseName(p: string): string {
  return (p.split(/[/\\]/).pop() ?? p).toLowerCase();
}

/** Resolve the active file to its integer source tag via the conversion's
 *  `sources` table. Returns null to mean "match any tag" — the single-file
 *  case (one source, or no table), where every locator refers to that file and
 *  tag filtering would only risk a false miss. */
export function resolveTag(sources: readonly string[] | undefined, activeFile: string): number | null {
  if (!sources || sources.length <= 1) return null;
  const want = baseName(activeFile);
  const idx = sources.findIndex((s) => baseName(s) === want);
  return idx >= 0 ? idx : null;
}
