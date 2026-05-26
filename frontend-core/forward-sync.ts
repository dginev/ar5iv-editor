// Forward source-map sync: scroll the preview to the most recently edited
// source line and pulse the matching construct. Ported unchanged in behavior
// from the web editor; the only difference is the shadow `host` is passed in
// rather than resolved from a module-global.

import { type ParsedSourcepos, parseSourcepos, resolveTag } from "./sourcepos";

/** Source-position ordering key for one stamped element; **lower wins**. We
 *  anchor to the construct that most recently *started* at or before the caret
 *  in source reading order `(line, col)` — the lexicographic generalisation of
 *  a line-only anchor, so it descends past a containing paragraph to the exact
 *  inline construct the caret sits in. The **line is authoritative**; the
 *  column only breaks ties *within* the anchor line, and only narrows to a
 *  descendant. `span` (line extent) collapses nested nodes sharing an exact
 *  start to the innermost. */
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
 *  `activeFile`, and pulse it. One linear pass, no layout reads; scroll + flash
 *  are deferred to one animation frame. Degrades to "nearest preceding
 *  construct" across gaps and error-truncated output. No-op only when the
 *  preview carries no locators at all. */
export function scrollPreviewToSource(
  host: HTMLElement,
  line: number,
  col: number,
  token: string,
  activeFile: string,
  sources?: readonly string[],
): void {
  const wantTag = resolveTag(sources, activeFile);

  let containing: { el: HTMLElement; lineSpan: number; colSpan: number } | null = null;
  let matched: { el: HTMLElement; key: RankKey } | null = null; // honours wantTag
  let any: { el: HTMLElement; key: RankKey } | null = null; // ignores wantTag

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
    // On an EQUAL key, prefer the LATER element in document order — the deeper,
    // more-specific node (the <h2> over its wrapping <section>).
    if (any === null || !keyLt(any.key, key)) any = { el, key };
    if (wantTag !== null && sp.fromTag !== wantTag) continue;
    if (matched === null || !keyLt(matched.key, key)) matched = { el, key };
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

  // Prefer the tightest element that actually CONTAINS the caret; else the
  // reading-order anchor (for collapsed-point inline constructs).
  let target = containing?.el ?? (matched ?? any)?.el ?? null;

  // Content-fingerprint refinement. Macro-argument text reports its construct's
  // END column (source columns are gone before digestion), so neither column
  // nor line can locate it — the edited word can. Scope to the caret's block
  // and pick the tightest element whose rendered text contains the word.
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
    } else if (containing === null) {
      // Out-of-source-order frontmatter (\title etc. render with no locator).
      // Map by content: the shortest frontmatter element whose text contains
      // the edited word. Scoped so body prose can't false-match.
      let best: { el: Element; len: number } | null = null;
      host
        .querySelectorAll(
          ".ltx_title_document,.ltx_subtitle,.ltx_personname,.ltx_creator,.ltx_date,.ltx_keywords,.ltx_classification,.ltx_role",
        )
        .forEach((el) => {
          const txt = el.textContent ?? "";
          if (txt.includes(token) && (best === null || txt.length < best.len)) {
            best = { el, len: txt.length };
          }
        });
      if (best !== null) target = (best as { el: Element }).el as HTMLElement;
    }
  }

  if (!target) return;

  // Defer to the next frame so the just-morphed DOM has laid out, then scroll;
  // the highlight starts on *arrival* so a long smooth scroll doesn't burn the
  // pulse before the eye gets there.
  requestAnimationFrame(() => {
    target!.scrollIntoView({ block: "center", behavior: "smooth" });
    flashOnArrival(host, target!);
  });
}

let syncAnim: Animation | null = null;

/** Flash the matched element's TEXT (text-width, like a selection) via the CSS
 *  Custom Highlight API — so a full-width block doesn't become a banner — with
 *  a fade. Falls back to the box-shadow ring class when unavailable. */
function flashElement(host: HTMLElement, el: HTMLElement): void {
  const reg = (CSS as unknown as { highlights?: { set(k: string, v: unknown): void; delete(k: string): void } })
    .highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (r: Range) => unknown }).Highlight;
  if (reg && HighlightCtor && el.firstChild) {
    try {
      const range = document.createRange();
      range.selectNodeContents(el);
      reg.set("ar5iv-sync", new HighlightCtor(range));
      syncAnim?.cancel();
      syncAnim = host.animate(
        [{ "--ar5iv-sync-alpha": 0.4 } as Keyframe, { "--ar5iv-sync-alpha": 0 } as Keyframe],
        { duration: 3000, easing: "ease-out" },
      );
      syncAnim.onfinish = () => {
        try {
          reg.delete("ar5iv-sync");
        } catch {
          /* registry already cleared */
        }
      };
      return;
    } catch {
      /* fall through to the ring fallback */
    }
  }
  el.classList.add("ar5iv-sync-flash");
  window.setTimeout(() => el.classList.remove("ar5iv-sync-flash"), 3000);
}

/** Light the highlight once `el` has stopped moving in the viewport (the smooth
 *  scroll arrived), or promptly when no scroll was needed, or at a hard cap so
 *  it can never hang. */
function flashOnArrival(host: HTMLElement, el: HTMLElement): void {
  const start = performance.now();
  let lastTop = el.getBoundingClientRect().top;
  let stableFrames = 0;
  let moved = false;
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
      flashElement(host, el);
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
