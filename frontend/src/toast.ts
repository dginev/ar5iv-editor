// Tiny toast helper. Phase 6 — replaces the v1.1 "stuff errors into
// the status line" pattern with a non-disruptive bottom-right stack
// that auto-dismisses after a few seconds.

export type ToastKind = "info" | "warn" | "error";

const TOAST_TTL_MS = 4000;
const FADE_MS = 250;

function stackEl(): HTMLElement | null {
  let el = document.getElementById("toast-stack");
  if (!el) {
    // Inject lazily so a missing template element isn't fatal.
    el = document.createElement("div");
    el.id = "toast-stack";
    el.className = "toast-stack";
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  return el;
}

export function showToast(message: string, kind: ToastKind = "info"): void {
  const stack = stackEl();
  if (!stack) return;
  const t = document.createElement("div");
  t.className = `toast toast--${kind}`;
  t.textContent = message;
  stack.appendChild(t);
  // Click anywhere to dismiss early.
  t.addEventListener("click", () => fadeOut(t));
  window.setTimeout(() => fadeOut(t), TOAST_TTL_MS);
}

function fadeOut(t: HTMLElement): void {
  if (!t.isConnected) return;
  t.classList.add("toast--leaving");
  window.setTimeout(() => t.remove(), FADE_MS);
}

const NOTICE_TTL_MS = 5000;

/**
 * Show a top-center notice banner. Heavier signal than `showToast`
 * (centered under the page header, themed with `--ok` accents) so
 * non-fatal-but-important messages (e.g. "we silently skipped 8 of
 * your files") don't slip past in the corner. Auto-dismisses after
 * `ttlMs`; any click anywhere on the page also dismisses it. Stacks
 * vertically if more than one fires before its predecessor expires.
 */
export function showNotice(message: string, ttlMs: number = NOTICE_TTL_MS): void {
  let stack = document.getElementById("notice-stack");
  if (!stack) {
    stack = document.createElement("div");
    stack.id = "notice-stack";
    stack.className = "notice-stack";
    stack.setAttribute("aria-live", "polite");
    document.body.appendChild(stack);
  }
  const n = document.createElement("div");
  n.className = "notice";
  n.setAttribute("role", "status");
  n.textContent = message;
  stack.appendChild(n);

  // Two dismissal paths: the timer, and the next click anywhere on
  // the page. Wrap both in a once-only `dismiss` so a click-then-
  // timeout (or vice versa) doesn't double-fade. The document
  // listener is registered after a microtask delay so the same
  // event tick that just produced this notice (e.g. an "upload"
  // button click whose response chain ended here) doesn't tear it
  // down before paint.
  let dismissed = false;
  const dismiss = (): void => {
    if (dismissed) return;
    dismissed = true;
    document.removeEventListener("pointerdown", dismiss, true);
    fadeOutNotice(n);
  };
  setTimeout(() => {
    if (!dismissed) document.addEventListener("pointerdown", dismiss, true);
  }, 0);
  window.setTimeout(dismiss, ttlMs);
}

function fadeOutNotice(n: HTMLElement): void {
  if (!n.isConnected) return;
  n.classList.add("notice--leaving");
  window.setTimeout(() => n.remove(), FADE_MS);
}

/**
 * Show a centered, full-width error card and schedule a hard page
 * refresh after `reloadAfterMs`. Used for non-recoverable failures
 * (typically a GC'd session that the browser tab missed) where a
 * 4-second toast is too easy to overlook and the only safe path
 * forward is to reload and start a fresh session.
 */
export function showFatalCard(
  title: string,
  detail: string,
  reloadAfterMs = 5000,
): void {
  // Idempotent: if a fatal card is already up, leave it alone — the
  // first one's countdown is already running.
  if (document.getElementById("fatal-card")) return;

  const card = document.createElement("div");
  card.id = "fatal-card";
  card.className = "fatal-card";
  card.setAttribute("role", "alertdialog");
  card.setAttribute("aria-live", "assertive");

  const titleEl = document.createElement("div");
  titleEl.className = "fatal-card__title";
  titleEl.textContent = title;
  card.appendChild(titleEl);

  const detailEl = document.createElement("div");
  detailEl.className = "fatal-card__detail";
  detailEl.textContent = detail;
  card.appendChild(detailEl);

  const countdown = document.createElement("div");
  countdown.className = "fatal-card__countdown";
  card.appendChild(countdown);

  document.body.appendChild(card);

  const start = performance.now();
  const tick = (): void => {
    const elapsed = performance.now() - start;
    const remaining = Math.max(0, reloadAfterMs - elapsed);
    const secs = Math.ceil(remaining / 1000);
    countdown.textContent = `Reloading in ${secs}s…`;
    if (remaining <= 0) {
      window.location.reload();
      return;
    }
    window.setTimeout(tick, 200);
  };
  tick();
}
