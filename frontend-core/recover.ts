// Best-effort reverse-sync recovery (preview → editor source position).
//
// A construct's source locator names a line, but that line isn't always where
// the clicked text actually lives: a multi-line font-switch wrapper reports
// only its start line, a large paragraph reports its first line while the
// clicked word sits many lines below, and macro-argument columns are unreliable
// (Bruce #101). Given a whitespace-normalized phrase the user double-clicked
// (plus the exact `word` within it), search the source for the phrase
// (whitespace-insensitive, so it matches across the source's own line breaks —
// the rendered text is reflowed), take the occurrence nearest the located line,
// then pinpoint `word` inside that match so the caret lands on the clicked word.
// If the phrase can't be matched — the common mixed-content case, where the
// context contains rendered math / citation glyphs (`[1]`, `x²`) absent from
// the source — fall back to the bare word nearest the located line. Returns the
// recovered 1-based line + column, or `null` to keep the locator's own position
// (nothing specific enough matched — never navigate somewhere worse).

export function recoverSourcePosition(
  src: string,
  targetLine: number,
  phrase: string,
  word: string,
): { line: number; col: number } | null {
  const fp = phrase.replace(/\s+/g, " ").trim();
  const w = word.replace(/\s+/g, " ").trim();
  // Whitespace-collapsed view of the source, with a back-map from each
  // normalized char to its (line, col). Runs of whitespace (incl. newlines)
  // become a single space, so a rendered phrase matches even where the source
  // wrapped it across lines.
  let norm = "";
  const lineOf: number[] = [];
  const colOf: number[] = [];
  let line = 1;
  let col = 1;
  let inWs = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (/\s/.test(ch)) {
      if (!inWs) {
        norm += " ";
        lineOf.push(line);
        colOf.push(col);
        inWs = true;
      }
      if (ch === "\n") {
        line++;
        col = 1;
      } else {
        col++;
      }
      continue;
    }
    inWs = false;
    norm += ch;
    lineOf.push(line);
    colOf.push(col);
    col++;
  }
  // The occurrence of `needle` whose start line is nearest the located line (so
  // the closest plausible match wins over a farther duplicate).
  const nearest = (needle: string): number => {
    let bestIdx = -1;
    let bestDist = Infinity;
    for (let idx = norm.indexOf(needle); idx !== -1; idx = norm.indexOf(needle, idx + 1)) {
      const dist = Math.abs(lineOf[idx]! - targetLine);
      if (dist < bestDist) {
        bestDist = dist;
        bestIdx = idx;
      }
    }
    return bestIdx;
  };
  // 1. The context phrase is specific enough to disambiguate; pinpoint `word`
  //    inside the matched region so the caret lands on the clicked word.
  if (fp.length >= 4) {
    const phraseIdx = nearest(fp);
    if (phraseIdx >= 0) {
      let pos = phraseIdx;
      if (w) {
        const wIdx = norm.indexOf(w, phraseIdx);
        if (wIdx !== -1 && wIdx <= phraseIdx + fp.length) pos = wIdx;
      }
      return { line: lineOf[pos]!, col: colOf[pos]! };
    }
  }
  // 2. Phrase didn't match (mixed content). The bare word usually does appear
  //    in the source; take the nearest occurrence. Require some length so a
  //    stray short token doesn't match all over.
  if (w.length >= 4) {
    const wordIdx = nearest(w);
    if (wordIdx >= 0) return { line: lineOf[wordIdx]!, col: colOf[wordIdx]! };
  }
  return null;
}
