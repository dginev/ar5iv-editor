// Pointer-driven column resizers for the three-pane shell.
//
// Layout: `.ar5iv-editor-shell` is a CSS Grid with five columns —
//   files (var) | resizer | source (var) | resizer | preview (1fr)
// We update the grid's CSS vars on `pointermove` and persist the final
// values to localStorage on `pointerup`. PointerEvents work for mouse
// and touch uniformly, so the resizers are usable on narrow screens
// too. Keyboard nudging via Left/Right is offered for a11y when a
// resizer has focus.
//
// The resizer DOM is plain `<div class="resizer" data-edge="..." />`;
// see `templates/editor.html`.

const LS_FILES = "ar5iv.layout.files";
const LS_SOURCE = "ar5iv.layout.source";

const MIN_FILES = 8;        // rem
const MAX_FILES = 28;       // rem
const MIN_SOURCE = 18;      // rem
const KEY_STEP = 0.5;       // rem per Left/Right press
/** The preview pane must always have at least this many rem visible
 *  on the right. Without this, a stale `--w-source` in localStorage
 *  (e.g. from a previous drag on a wider monitor) could push the
 *  preview pane off-screen entirely. */
const PREVIEW_RESERVE = 16; // rem

function rootStyle(): CSSStyleDeclaration | null {
  const shell = document.querySelector<HTMLElement>(".ar5iv-editor-shell");
  return shell?.style ?? null;
}

function pxPerRem(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function loadStored(): { files: number; source: number } {
  const f = parseFloat(localStorage.getItem(LS_FILES) ?? "");
  const s = parseFloat(localStorage.getItem(LS_SOURCE) ?? "");
  return {
    files: Number.isFinite(f) ? f : 14,
    source: Number.isFinite(s) ? s : 32,
  };
}

function setColumns(filesRem: number, sourceRem: number): void {
  const style = rootStyle();
  if (!style) return;
  const ppr = pxPerRem();
  const viewportRem = window.innerWidth / ppr;
  const filesClamp = Math.max(MIN_FILES, Math.min(MAX_FILES, filesRem));
  // Cap the source-pane width so the preview always has at least
  // PREVIEW_RESERVE rem visible. Two 4-px resizers + a small slack
  // round out the calc.
  const resizersRem = (8 + 4) / ppr; // two resizers + small slack
  const sourceMax = Math.max(
    MIN_SOURCE,
    viewportRem - filesClamp - resizersRem - PREVIEW_RESERVE,
  );
  const sourceClamp = Math.max(MIN_SOURCE, Math.min(sourceMax, sourceRem));
  style.setProperty("--w-files", `${filesClamp}rem`);
  style.setProperty("--w-source", `${sourceClamp}rem`);
}

interface DragState {
  edge:    "files-source" | "source-preview";
  startX:  number;
  startW: number;
  /** When dragging the source/preview separator we read+persist the
   *  source column. When dragging the files/source separator we
   *  read+persist the files column. */
}

export function bootResizers(): void {
  const stored = loadStored();
  setColumns(stored.files, stored.source);
  // Persist the *clamped* values immediately so a stale localStorage
  // entry (e.g. saved on a wider monitor) gets healed in place. Without
  // this, every page load would re-clamp from the same broken stored
  // value.
  persistFromLive();

  document
    .querySelectorAll<HTMLElement>(".ar5iv-editor-shell > .resizer")
    .forEach((handle) => wireOne(handle));

  // Reclamp on window resize so a shrink doesn't leave the preview
  // pushed off-screen. Cheap; no debounce needed.
  window.addEventListener("resize", () => {
    const stored = loadStored();
    setColumns(stored.files, stored.source);
  });
}

function wireOne(handle: HTMLElement): void {
  const edge = (handle.dataset.edge ?? "") as DragState["edge"];
  if (edge !== "files-source" && edge !== "source-preview") return;

  let drag: DragState | null = null;
  const ppr = pxPerRem();

  handle.addEventListener("pointerdown", (ev) => {
    handle.setPointerCapture(ev.pointerId);
    handle.classList.add("resizer--dragging");
    const stored = loadStored();
    drag = {
      edge,
      startX: ev.clientX,
      startW: edge === "files-source" ? stored.files : stored.source,
    };
    ev.preventDefault();
  });

  const onMove = (ev: PointerEvent) => {
    if (!drag) return;
    const delta = (ev.clientX - drag.startX) / ppr;
    const stored = loadStored();
    if (drag.edge === "files-source") {
      setColumns(drag.startW + delta, stored.source);
    } else {
      setColumns(stored.files, drag.startW + delta);
    }
  };
  const onUp = () => {
    if (!drag) return;
    drag = null;
    handle.classList.remove("resizer--dragging");
    persistFromLive();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);

  handle.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    const dir = ev.key === "ArrowRight" ? 1 : -1;
    const stored = loadStored();
    if (edge === "files-source") {
      setColumns(stored.files + dir * KEY_STEP, stored.source);
    } else {
      setColumns(stored.files, stored.source + dir * KEY_STEP);
    }
    persistFromLive();
    ev.preventDefault();
  });
}

function persistFromLive(): void {
  const style = rootStyle();
  if (!style) return;
  const filesVar = parseFloat(style.getPropertyValue("--w-files"));
  const sourceVar = parseFloat(style.getPropertyValue("--w-source"));
  if (Number.isFinite(filesVar)) localStorage.setItem(LS_FILES, String(filesVar));
  if (Number.isFinite(sourceVar)) localStorage.setItem(LS_SOURCE, String(sourceVar));
}
